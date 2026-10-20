# Request Caller

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs}}

The host shows the Owner which app is using the server. It learns that from the response: **both bearer gates stamp a verified request's response with the token's client, as a `RequestCaller`, and a request they refuse with a `RequestRefusal` saying why.** A path the gate exempts carries neither.

The two gates are [`require_valid_session`](<../HTTP/Middleware Explanation.md#item-require_valid_session>), on the `/authorization` routes (the "session gate"), and [`authorization_server_auth_middleware`](<../HTTP/Middleware Explanation.md#item-authorization_server_auth_middleware>), on the host's other routers (the "bearer gate"). Both verify through [`verify_request_claims`](<../HTTP/Middleware Explanation.md#item-verify_request_claims>).

This file's own helpers are on the [Test Fixtures](<Test Fixtures Explanation.md#integrationrequest_caller>) page, with the shared ones.

## `integration::request_caller`

### `the_bearer_gate_stamps_the_token_s_client`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs the_bearer_gate_stamps_the_token_s_client}}

Relies on [`authorization_server_auth_middleware`](<../HTTP/Middleware Explanation.md#item-authorization_server_auth_middleware>). Fixtures first used here: [`spin_up`](<Test Fixtures Explanation.md#item-spin_up>), [`mint_scoped_token`](<Test Fixtures Explanation.md#item-mint_scoped_token>), [`bearer_gated_router`](<Test Fixtures Explanation.md#item-bearer_gated_router>), [`get_with_bearer`](<Test Fixtures Explanation.md#item-get_with_bearer>) and [`stamped_caller`](<Test Fixtures Explanation.md#item-stamped_caller>).

### `the_bearer_gate_stamps_nothing_on_a_rejected_or_exempt_request`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs the_bearer_gate_stamps_nothing_on_a_rejected_or_exempt_request}}

Relies on [`authorization_server_auth_middleware`](<../HTTP/Middleware Explanation.md#item-authorization_server_auth_middleware>).

### `the_session_gate_stamps_the_token_s_client`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs the_session_gate_stamps_the_token_s_client}}

Relies on [`require_valid_session`](<../HTTP/Middleware Explanation.md#item-require_valid_session>). Fixtures first used here: [`owner_grants_probe`](<Test Fixtures Explanation.md#item-owner_grants_probe>) and [`OWNER_TOKEN_CLIENT_ID`](<Test Fixtures Explanation.md#item-OWNER_TOKEN_CLIENT_ID>).

### `the_session_gate_stamps_nothing_on_a_rejected_request`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs the_session_gate_stamps_nothing_on_a_rejected_request}}

Relies on [`require_valid_session`](<../HTTP/Middleware Explanation.md#item-require_valid_session>).

### `the_bearer_gate_stamps_why_it_refused_each_401`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs the_bearer_gate_stamps_why_it_refused_each_401}}

Relies on [`AccessTokenVerifyError`](<../Domain/Access Token Explanation.md#item-AccessTokenVerifyError>) and [`verify_request_claims`](<../HTTP/Middleware Explanation.md#item-verify_request_claims>). Fixtures first used here: [`revoke`](<Test Fixtures Explanation.md#item-request_caller--revoke>) and [`stamped_refusal`](<Test Fixtures Explanation.md#item-stamped_refusal>).

### `the_session_gate_stamps_why_it_refused_each_401`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs the_session_gate_stamps_why_it_refused_each_401}}

Relies on [`AccessTokenVerifyError`](<../Domain/Access Token Explanation.md#item-AccessTokenVerifyError>) and [`verify_request_claims`](<../HTTP/Middleware Explanation.md#item-verify_request_claims>). Fixtures first used here: [`build_request`](<Test Fixtures Explanation.md#item-build_request>).

### `a_scope_refusal_carries_the_caller_and_no_refusal`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs a_scope_refusal_carries_the_caller_and_no_refusal}}

Relies on [`require_valid_session`](<../HTTP/Middleware Explanation.md#item-require_valid_session>).
