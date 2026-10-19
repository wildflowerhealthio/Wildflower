# Request Caller

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs}}

The host shows the Owner which app is using the server. It learns that from the response: **both bearer-checking gates stamp a verified request's response with the token's client, as a `RequestCaller`, and a request they refuse with a `RequestRefusal` saying why.** A path the gate exempts carries neither.

The two gates are {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_auth.rs require_valid_session}}, on the `/authorization` routes (the "session gate"), and {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_valid_bearer_token.rs authorization_server_auth_middleware}}, on the host's other routers (the "bearer gate"). Both verify through {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_auth.rs verify_request_claims}}.

## Helpers

What a response was stamped with:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs stamped_caller}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs stamped_refusal}}

Revoking a token by its `jti`:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs revoke}}

A small router behind the bearer gate, with `/metadata` exempt, and a `GET` with an optional bearer:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs bearer_gated_router}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs get_with_bearer}}

## `the_bearer_gate_stamps_the_token_s_client`

**A request the bearer gate admits is stamped with its token's client.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs the_bearer_gate_stamps_the_token_s_client}}

## `the_bearer_gate_stamps_nothing_on_a_rejected_or_exempt_request`

**A rejected or exempt request names no caller.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs the_bearer_gate_stamps_nothing_on_a_rejected_or_exempt_request}}

## `the_bearer_gate_stamps_why_it_refused_each_401`

**Each `401` from the bearer gate says why: no token, a token that didn't verify, or a revoked one.** An exempt path is not refused.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs the_bearer_gate_stamps_why_it_refused_each_401}}

Relies on [`VerifyError`](<../Domain/Token Explanation.md#verifyerror>).

## `the_session_gate_stamps_the_token_s_client`

**A request the session gate admits is stamped with its token's client.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs the_session_gate_stamps_the_token_s_client}}

## `the_session_gate_stamps_nothing_on_a_rejected_request`

**A request the session gate rejects names no caller.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs the_session_gate_stamps_nothing_on_a_rejected_request}}

## `the_session_gate_stamps_why_it_refused_each_401`

**Each `401` from the session gate says why**, as the bearer gate's do.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs the_session_gate_stamps_why_it_refused_each_401}}

## `a_scope_refusal_carries_the_caller_and_no_refusal`

**A token too narrow for the route is refused with a `403` after the gate verified it.** So the response names its caller and carries no refusal.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs a_scope_refusal_carries_the_caller_and_no_refusal}}
