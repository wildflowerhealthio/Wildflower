# Scope Gating

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/scope_gating.rs}}

The `/authorization` surface checks two things in turn. The session gate proves who the caller is: no valid token is a `401` ([Smoke](<Smoke Explanation.md>)). Each route then asks for the scope its capability needs. **A valid token without that scope is a `403` naming the missing scope, decided before the handler runs.** A wildcard covers every resource it names, by [`allowed_scope_covers`](<../Domain/Scopes Explanation.md#item-allowed_scope_covers>). Logout and the session read are self-service and take no scope.

## `integration::scope_gating`

### `access_grants_list_with_grant_read_scope_returns_200`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/scope_gating.rs access_grants_list_with_grant_read_scope_returns_200}}

Relies on [`require_valid_session`](<../HTTP/Middleware Explanation.md#item-require_valid_session>). Fixtures first used here: [`spin_up`](<Test Fixtures Explanation.md#item-spin_up>), [`mint_scoped_token`](<Test Fixtures Explanation.md#item-mint_scoped_token>), [`build_request`](<Test Fixtures Explanation.md#item-build_request>) and [`body_json`](<Test Fixtures Explanation.md#item-body_json>).

### `access_grants_list_with_wildflower_wildcard_returns_200`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/scope_gating.rs access_grants_list_with_wildflower_wildcard_returns_200}}

Relies on [`allowed_scope_covers`](<../Domain/Scopes Explanation.md#item-allowed_scope_covers>).

### `access_grants_delete_with_only_read_scope_returns_403_missing_delete`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/scope_gating.rs access_grants_delete_with_only_read_scope_returns_403_missing_delete}}

Relies on [`require_valid_session`](<../HTTP/Middleware Explanation.md#item-require_valid_session>).

### `access_grants_delete_with_grant_delete_scope_passes_the_gate`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/scope_gating.rs access_grants_delete_with_grant_delete_scope_passes_the_gate}}

Relies on [`GrantsRevoker::revoke`](<../Capabilities/Access/Grants Explanation.md#item-GrantsRevoker--revoke>).

### `access_revocations_requires_token_delete_scope`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/scope_gating.rs access_revocations_requires_token_delete_scope}}

Relies on [`handle_create_revocation`](<../HTTP/Routes/Session Routes Explanation.md#item-handle_create_revocation>).

### `access_logout_is_self_service_any_valid_bearer`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/scope_gating.rs access_logout_is_self_service_any_valid_bearer}}

Relies on [`handle_logout`](<../HTTP/Routes/Session Routes Explanation.md#item-handle_logout>).

### `access_session_reports_the_callers_own_scopes_without_an_admin_scope`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/scope_gating.rs access_session_reports_the_callers_own_scopes_without_an_admin_scope}}

Relies on [`VerifiedClaims::granted`](<../Domain/Access Token Explanation.md#item-VerifiedClaims--granted>).

### `access_session_without_a_token_is_401_not_an_empty_scope_list`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/scope_gating.rs access_session_without_a_token_is_401_not_an_empty_scope_list}}

Relies on [`require_valid_session`](<../HTTP/Middleware Explanation.md#item-require_valid_session>).
