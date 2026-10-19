# Scope Gating

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/scope_gating.rs}}

The `/authorization` surface checks two things in turn. The session gate proves who the caller is: no valid token is a `401` ([Smoke](<Smoke Explanation.md>) covers that). Each route then asks for the scope it needs. **A valid token without that scope is a `403` naming the missing scope, decided before the handler runs.** A wildcard covers every resource it names. A few self-service routes take no scope at all.

The tokens here come from [mint_scoped_token](<../Integration Tests Explanation.md#mint_scoped_token>), which mints a token holding exactly the scopes it is given.

## `access_grants_list_with_grant_read_scope_returns_200`

**`wildflower/Grant.r` is enough to list grants.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/scope_gating.rs access_grants_list_with_grant_read_scope_returns_200}}

## `access_grants_list_with_wildflower_wildcard_returns_200`

**`wildflower/*.cruds` covers `wildflower/Grant.r`**, so a token holding the wildcard passes the per-resource gate.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/scope_gating.rs access_grants_list_with_wildflower_wildcard_returns_200}}

## `access_grants_delete_with_only_read_scope_returns_403_missing_delete`

**Reading grants doesn't let you revoke one.** The gate answers `403 InsufficientScope` naming `wildflower/Grant.d`, before the handler, so even an unknown id is a `403`, never a `404`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/scope_gating.rs access_grants_delete_with_only_read_scope_returns_403_missing_delete}}

## `access_grants_delete_with_grant_delete_scope_passes_the_gate`

**`wildflower/Grant.d` clears the gate.** The handler runs and reports the unknown grant as `404`, which shows the gate let it through.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/scope_gating.rs access_grants_delete_with_grant_delete_scope_passes_the_gate}}

## `access_revocations_requires_token_delete_scope`

**Revoking tokens takes `wildflower/Token.d`.** Without it the answer is a `403` naming it; with it the revocation succeeds.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/scope_gating.rs access_revocations_requires_token_delete_scope}}

## `access_logout_is_self_service_any_valid_bearer`

**Logging out takes no scope**: any valid bearer can log itself out.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/scope_gating.rs access_logout_is_self_service_any_valid_bearer}}

## `access_session_reports_the_callers_own_scopes_without_an_admin_scope`

**`GET /authorization/session` takes no scope and reports the caller's own scopes.** The callers who need it are under-scoped sessions arriving from a `403`; a scope gate would lock them out of reading what they hold.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/scope_gating.rs access_session_reports_the_callers_own_scopes_without_an_admin_scope}}

## `access_session_without_a_token_is_401_not_an_empty_scope_list`

**The session read still needs a valid token.** Without one it is a `401`, never a `200` with no scopes, which would read as "this session holds nothing" rather than "there is no session".

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/scope_gating.rs access_session_without_a_token_is_401_not_an_empty_scope_list}}
