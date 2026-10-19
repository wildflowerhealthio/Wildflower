# Grants

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs}}

The Owner's list of trusted apps shows every [standing grant](<../../Domain/Grant Explanation.md>): what each app, or each device, was allowed, and when. Reading it takes `wildflower/Grant.r`. Revoking a grant takes `wildflower/Grant.d`, and **revoking a grant ends what was issued under it**: the app's live access tokens and its refresh tokens die with the consent, so no app with `offline_access` outlives its revoked consent.

## `grants_reader_scopes`

The gate on reading the grants: `wildflower/Grant.r`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs grants_reader_scopes}}

## `grants_revoker_scopes`

The gate on revoking one: `wildflower/Grant.d`. Revoking a grant kills tokens too, but that is part of revoking a grant, so it doesn't also take `wildflower/Token.d`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs grants_revoker_scopes}}

## `GrantsReader`

Read access to the standing grants, behind `GET /authorization/grants` and `GET /authorization/grants/{id}`. It holds only the store.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs GrantsReader}}

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs GrantsReader::new GrantsRevoker::new}}

## `list`

Every standing grant, code-flow and device alike, in one read scope.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs GrantsReader::list}}

No unit test of its own. Exercised end to end by [`access_grants_with_owner_token_returns_empty_list`](<../../Integration Tests/Smoke Explanation.md#access_grants_with_owner_token_returns_empty_list>), [`consent_approval_persists_grant`](<../../Integration Tests/Grant Flows Explanation.md#consent_approval_persists_grant>) and [`access_grants_list_with_grant_read_scope_returns_200`](<../../Integration Tests/Scope Gating Explanation.md#access_grants_list_with_grant_read_scope_returns_200>).

## `get`

One grant by id, or `GrantNotFound`, which the route answers with a `404`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs GrantsReader::get}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs tests::get_returns_the_row_or_grant_not_found}}

A stored grant is returned by its id; an unknown id is `GrantNotFound` naming it.

Exercised end to end by [`get_unknown_grant_returns_404`](<../../Integration Tests/Smoke Explanation.md#get_unknown_grant_returns_404>).

## `GrantsRevoker`

Revoke a standing grant, behind `DELETE /authorization/grants/{id}`. Besides the store it holds the [revocation port](<../../Assembly/Ports and Adapters Explanation.md>), whose per-subject epoch ends a client's live access tokens.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs GrantsRevoker}}

## `revoke`

**Revoking a grant ends the app's standing consent and its standing credentials together.** It runs in three steps:

1. A read scope loads the grant, for its app.
2. The app's revocation epoch is bumped to now, which kills every access token the app holds.
3. A write scope deletes the grant, and expires every refresh-token family of the app: each family's deadline is set to the revoke instant, and its live token stamped consumed.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs GrantsRevoker::revoke}}

It is the one capability with two scopes, because the epoch lives on the revocation store and can't sit inside the grant store's write lock. **The epoch goes first.** A bump whose delete then fails over-revokes, which a retry repairs: it finds the grant and finishes. A delete that committed without its bump would leave live access tokens, and a retry would only answer `404`.

The epoch and the families are per app, not per grant: revoking one of an app's grants ends every access token and refresh family the app holds. The delete tries both grant tables. Grant ids are unique across them, so at most one row goes; a grant that vanished between the read and the delete is `GrantNotFound`.

### Test fixtures

The tests record which subjects the revocation port was asked to bump.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs tests::SubjectsRevoked}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs tests::revoke_maps_the_miss_to_grant_not_found}}

The first revoke succeeds and bumps the app's epoch. The second is `GrantNotFound`, and bumps nothing: the app is in the list once.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs tests::revoke_also_expires_the_clients_refresh_families}}

After the revoke the grant is gone, and the app's refresh family is still stored but expires at the revoke instant.

Exercised end to end by [`revoking_a_grant_bumps_the_client_revocation_epoch`](<../../Integration Tests/Revocation Explanation.md#revoking_a_grant_bumps_the_client_revocation_epoch>), [`revoking_a_device_grant_bumps_the_client_revocation_epoch`](<../../Integration Tests/Revocation Explanation.md#revoking_a_device_grant_bumps_the_client_revocation_epoch>), [`revoking_a_grant_of_the_host_app_s_client_bumps_its_epoch`](<../../Integration Tests/Revocation Explanation.md#revoking_a_grant_of_the_host_app_s_client_bumps_its_epoch>), [`revoking_grant_revokes_refresh_tokens`](<../../Integration Tests/Device Code Explanation.md#revoking_grant_revokes_refresh_tokens>) and [`access_grants_delete_with_only_read_scope_returns_403_missing_delete`](<../../Integration Tests/Scope Gating Explanation.md#access_grants_delete_with_only_read_scope_returns_403_missing_delete>).
