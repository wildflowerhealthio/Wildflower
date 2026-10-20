# Grants

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs}}

The Owner's list of trusted apps shows every [standing grant](<../../Domain/Grant Explanation.md>): what each app, or each device, was allowed, and when it was last used. **Revoking a grant ends what was issued under it**: the app's live [access tokens](<../../Domain/Access Token Explanation.md>) and its [refresh families](<../../Domain/Refresh Token Explanation.md>) die with the consent, so no app holding `offline_access` outlives its revoked consent.

The access tokens die through the host's revocation store, which keeps a per-subject epoch outside the grant store: a token issued before its subject's epoch no longer verifies. A token's subject is its app's `client_id`, so the epoch, and with it the revoke, is per app, not per grant. The revocation store is reached through the [`Revocation`](<../../Assembly/Ports and Adapters Explanation.md>) port.

## `domain::capabilities::access::grants`

### `grants_reader_scopes`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs grants_reader_scopes}}

### `grants_revoker_scopes`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs grants_revoker_scopes}}

### `GrantsReader`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs GrantsReader}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs GrantsReader::new}}

#### `list`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs GrantsReader::list}}

#### `get`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs GrantsReader::get tests="tests::get_returns_the_row_or_grant_not_found"}}

### `GrantsRevoker`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs GrantsRevoker}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs GrantsRevoker::new}}

#### `revoke`

The tests record the subjects the revocation port is asked to bump, through a [recording port](<../Test Fixtures Explanation.md#grants>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs GrantsRevoker::revoke tests="tests::revoke_maps_the_miss_to_grant_not_found tests::revoke_also_expires_the_clients_refresh_families"}}
