# Smoke

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/smoke.rs}}

The server's most basic promises. It publishes its public signing key and nothing private. **Every gated route needs a bearer token minted by this server for this server**: a token's `iss` and `aud` must both be the server's origin.

Two gates check bearers. [`require_valid_session`](<../HTTP/Middleware Explanation.md#item-require_valid_session>) guards the server's own `/authorization` routes. [`authorization_server_auth_middleware`](<../HTTP/Middleware Explanation.md#item-authorization_server_auth_middleware>) wraps the host's other routers, with the paths it lets through untouched. Both read the token as [`verify_access_token`](<../Domain/Access Token Explanation.md#item-verify_access_token>) does, with the key the [Signing Key](<../Domain/Signing Key Explanation.md>) page explains.

This file's own helpers are on the [Test Fixtures](<Test Fixtures Explanation.md#integrationsmoke>) page, with the shared ones.

## `integration::smoke`

### `jwks_endpoint_returns_seeded_key`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/smoke.rs jwks_endpoint_returns_seeded_key}}

Relies on [`SigningKey`](<../Domain/Signing Key Explanation.md#item-SigningKey>) and its public half, [`PublicJwk`](<../Domain/Signing Key Explanation.md#item-PublicJwk--from>). Fixtures first used here: [`spin_up`](<Test Fixtures Explanation.md#item-spin_up>), [`build_request`](<Test Fixtures Explanation.md#item-build_request>) and [`body_json`](<Test Fixtures Explanation.md#item-body_json>).

### `bearer_gate_exempts_listed_paths_but_gates_the_rest`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/smoke.rs bearer_gate_exempts_listed_paths_but_gates_the_rest}}

Relies on [`authorization_server_auth_middleware`](<../HTTP/Middleware Explanation.md#item-authorization_server_auth_middleware>).

### `access_grants_without_auth_returns_401`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/smoke.rs access_grants_without_auth_returns_401}}

Relies on [`require_valid_session`](<../HTTP/Middleware Explanation.md#item-require_valid_session>).

### `access_grants_with_owner_token_returns_empty_list`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/smoke.rs access_grants_with_owner_token_returns_empty_list}}

Relies on [`require_valid_session`](<../HTTP/Middleware Explanation.md#item-require_valid_session>).

### `a_token_for_this_server_passes`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/smoke.rs a_token_for_this_server_passes}}

Relies on [`verify_access_token`](<../Domain/Access Token Explanation.md#item-verify_access_token>). Fixtures first used here: [`mint_scoped_token`](<Test Fixtures Explanation.md#item-mint_scoped_token>) and [`access_grants_status`](<Test Fixtures Explanation.md#item-access_grants_status>).

### `a_token_not_naming_this_server_as_iss_and_aud_is_rejected`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/smoke.rs a_token_not_naming_this_server_as_iss_and_aud_is_rejected}}

Relies on [`verify_access_token`](<../Domain/Access Token Explanation.md#item-verify_access_token>) and [`AccessTokenVerifyOptions`](<../Domain/Access Token Explanation.md#item-AccessTokenVerifyOptions>). Fixtures first used here: [`SERVER_ORIGIN`](<Test Fixtures Explanation.md#item-SERVER_ORIGIN>) and [`mint_token_naming`](<Test Fixtures Explanation.md#item-mint_token_naming>).

### `get_unknown_grant_returns_404`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/smoke.rs get_unknown_grant_returns_404}}

Relies on [`AuthorizationServerError`](<../Domain/Errors Explanation.md#item-AuthorizationServerError>).
