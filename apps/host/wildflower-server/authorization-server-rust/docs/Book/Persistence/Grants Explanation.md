# Grants

{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/grants/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/grants/general.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/grants/authorization_code.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/grants/device.rs}}

A [grant](<../Domain/Grant Explanation.md>) is the Owner's standing yes, and it comes in two kinds. The store keeps **one table per kind**, `authorization_code_grants` and `device_grants`, each carrying every column its kind needs. A write or a keyed lookup of one kind is one statement on one table, and the store never has to keep a parent row and a child row in step.

Each table's identity is a unique key declared in the schema. `(client_id, redirect_uri)` holds code grants to **one standing consent per app per redirect URI**, so two approvals racing to insert can't both succeed; `(client_id, device_name)` holds device grants to **one pairing per app per device name**.

The Owner's list and the lookup by id span both kinds. Those read a `grants` view, a `UNION ALL` of the two tables that tags each row with its kind and leaves the other kind's own column `NULL`. Grant ids are UUIDs minted when the grant is first recorded, so an id names at most one row across both tables.

## `db::grants`

Each [`GrantsTx`](<../Grant Store/Grants Explanation.md#item-GrantsTx>) method on `SqliteGrantTx` is one line handing its connection to a statement below, in its kind's file or, when it spans both kinds, in `general`.

## `db::grants::general`

### `GrantViewRow`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grants/general.rs GrantViewRow}}

#### Into a `Grant`

The view selects each kind's own column from that kind's table, where it is `NOT NULL`, so a row missing its own column can't arise; the check is there anyway, and is a logged 500, never a panic. The round trip draws grants of either kind from [`arb_grant`](<Test Fixtures Explanation.md#item-tests--arb_grant>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grants/general.rs Grant::try_from tests="tests::create_and_fetch_round_trip"}}

### `all_grants`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grants/general.rs all_grants tests="tests::code_and_device_grants_coexist_per_client"}}

### `grant_by_id`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grants/general.rs grant_by_id}}

### `delete_authorization_code_grant`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grants/general.rs delete_authorization_code_grant}}

### `delete_device_grant`

**Standing consent and standing credentials end together.** The revoke runs both deletes and [`expire_refresh_token_families_for_client`](<Refresh Tokens Explanation.md#item-SqliteGrantTx--expire_refresh_token_families_for_client>) in one write scope, so either the grant is gone and every refresh family the app holds has ended, or nothing changed. The test drives them through [`revoke_grant`](<Test Fixtures Explanation.md#item-tests--revoke_grant>), which runs the same three statements as [`GrantsRevoker::revoke`](<../Capabilities/Access/Grants Explanation.md#item-GrantsRevoker--revoke>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grants/general.rs delete_device_grant tests="tests::revoke_removes_the_row_and_expires_the_clients_families"}}

## `db::grants::authorization_code`

### `create_authorization_code_grant`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grants/authorization_code.rs create_authorization_code_grant}}

### `grant_by_client_and_redirect`

`/oauth/authorize` asks it whether a request can skip the Owner ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs GrantCoverage::resolve}}), an approval asks it for the grant to fold into, and a code redemption asks it for the grant id to record on its refresh family. The redirect URI is matched on its exact string.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grants/authorization_code.rs grant_by_client_and_redirect}}

### `update_authorization_code_grant`

The test drives the read-then-create-or-update of an approval through [`upsert_code_grant`](<Test Fixtures Explanation.md#item-tests--upsert_code_grant>), which follows the [grant recorder](<../Writers/Grant Recorder Explanation.md>) minus its registration write.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grants/authorization_code.rs update_authorization_code_grant tests="tests::upsert_action_inserts_then_unions_scopes_over_sqlite"}}

### `stamp_authorization_code_grant_used`

A code issued without asking the Owner stamps the grant that let it through.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grants/authorization_code.rs stamp_authorization_code_grant_used tests="tests::a_reapproval_keeps_the_stamp_over_sqlite"}}

## `db::grants::device`

### `create_device_grant`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grants/device.rs create_device_grant}}

### `device_grant_by_client_and_device_name`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grants/device.rs device_grant_by_client_and_device_name}}

### `update_device_grant`

The test pairs through [`upsert_device_grant`](<Test Fixtures Explanation.md#item-tests--upsert_device_grant>), the device counterpart.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grants/device.rs update_device_grant tests="tests::upsert_action_inserts_then_unions_scopes_over_sqlite"}}

### `stamp_device_grant_used`

A refresh family the grant earned rotating stamps it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grants/device.rs stamp_device_grant_used tests="tests::a_repairing_keeps_the_stamp_over_sqlite"}}
