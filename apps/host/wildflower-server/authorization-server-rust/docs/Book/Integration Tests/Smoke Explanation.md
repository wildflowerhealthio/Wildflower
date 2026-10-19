# Smoke

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/smoke.rs}}

The server's most basic promises. It publishes its public signing key and nothing private. **Every gated route needs a bearer token minted by this server for this server.** A token's `iss` and `aud` must both be the server's origin.

Two gates check bearers. {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_auth.rs require_valid_session}} guards the server's own `/authorization` routes. {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_valid_bearer_token.rs authorization_server_auth_middleware}} wraps the host's other routers, with paths it lets through untouched. Read the [Signing Key](<../Domain/Signing Key Explanation.md>) and [Token](<../Domain/Token Explanation.md>) pages first.

## Helpers

The status `GET /authorization/grants` answers a token:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/smoke.rs access_grants_status}}

## `jwks_endpoint_returns_seeded_key`

**The JWKS endpoint publishes the signing key's public half, and nothing private.** The whole body is compared, so a private field such as `d` would fail it.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/smoke.rs jwks_endpoint_returns_seeded_key}}

Relies on [Signing Key](<../Domain/Signing Key Explanation.md>).

## `bearer_gate_exempts_listed_paths_but_gates_the_rest`

**The bearer gate lets an exempt path through without a token, matching the whole path exactly.** A path that only shares the exempt path's prefix is gated like any other.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/smoke.rs bearer_gate_exempts_listed_paths_but_gates_the_rest}}

## `access_grants_without_auth_returns_401`

**`/authorization` routes refuse a request with no token: `401`.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/smoke.rs access_grants_without_auth_returns_401}}

## `access_grants_with_owner_token_returns_empty_list`

**The Owner's token reads the grants list**, empty on a fresh server.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/smoke.rs access_grants_with_owner_token_returns_empty_list}}

## `a_token_for_this_server_passes`

**A token naming this server as issuer and audience is accepted.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/smoke.rs a_token_for_this_server_passes}}

## `a_token_not_naming_this_server_as_iss_and_aud_is_rejected`

**A token another server minted is refused, even holding the Owner's scopes and signed with a key this server holds.** So is one naming another server as only its issuer or only its audience, and one whose audience is a path under this server's origin.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/smoke.rs a_token_not_naming_this_server_as_iss_and_aud_is_rejected}}

Tokens come from [mint_token_naming](<../Integration Tests Explanation.md#mint_token_naming>). Relies on [`verify_jwt`](<../Domain/Token Explanation.md#verify_jwt>).

## `get_unknown_grant_returns_404`

**Reading a grant that doesn't exist is `404 GrantNotFound`.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/smoke.rs get_unknown_grant_returns_404}}
