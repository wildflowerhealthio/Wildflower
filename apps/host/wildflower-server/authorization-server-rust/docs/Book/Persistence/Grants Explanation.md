# Grants

{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/grants/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/grants/general.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/grants/authorization_code.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/grants/device.rs}}

A [grant](<../Domain/Grant Explanation.md>) is the Owner's standing yes, and it comes in two kinds. The store keeps **one table per kind**: `authorization_code_grants` and `device_grants`, each carrying every column its kind needs, the shared ones and its own. A write or a keyed lookup of one kind is therefore one statement on one table, and the store never has to keep a parent row and a child row in step.

Each table's identity is a unique key, declared in the schema:

| Table                       | Unique key                  | What it means                                                                                         |
| --------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `authorization_code_grants` | `(client_id, redirect_uri)` | **One standing consent per app per redirect URI.** Two approvals racing to insert can't both succeed. |
| `device_grants`             | `(client_id, device_name)`  | **One pairing per app per device name.** `device_name` is `NOT NULL`, so the key covers every row.    |

The Owner's list and the by-id lookup span both kinds. Those read a `grants` view, a `UNION ALL` of the two tables that tags each row with its kind (`authorization_code` or `device_code`) and leaves the other kind's own column NULL. Grant ids are UUIDs minted when the grant is first recorded, so an id names at most one row across both tables.

Each `GrantsTx` method on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs SqliteGrantTx}} is one line in `db/grants/mod.rs` handing its connection to the statement below, which lives in its kind's file (`authorization_code.rs`, `device.rs`) or, when it spans both kinds, in `general.rs`. Every section names the port method it implements; the port's section says what the domain relies on.

## Test fixtures

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grants/general.rs tests::arb_shared}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grants/general.rs tests::arb_grant}}

Any grant of either kind: the shared columns from `arb_shared`, plus a redirect URI for a code grant or a printable device name for a device grant.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grants/general.rs tests::revoke_grant}}

A revoke the tests can drive against the real store: both deletes and the app's refresh-family expiry in one write scope, then `GrantNotFound` if neither delete removed a row. It runs the same three statements as {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs GrantsRevoker::revoke}}, but not in the same shape: the real revoke reports the miss inside the scope, so a miss expires nothing, and it revokes the app's access tokens before it opens the scope.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grants/authorization_code.rs tests::upsert_code_grant}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grants/device.rs tests::upsert_device_grant}}

The record-a-grant step of an approval, against the real store: read the standing grant for the key; if there is one, fold the new approval into it and update; if not, insert a fresh one. These follow {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs GrantRecorder::record_code_grant}} and {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs GrantRecorder::record_device_grant}}, minus the code grant's registration write.

## `create_authorization_code_grant`

A first approval of an app at a redirect URI. A plain insert of the whole grant; the unique `(client_id, redirect_uri)` key refuses a second row for the same pair. Port: [`create_authorization_code_grant`](<../Grant Store/Grants Explanation.md#create_authorization_code_grant>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grants/authorization_code.rs create_authorization_code_grant}}

The caller hands over the concrete kind, so the store never looks inside a `Grant` to choose a table. No unit test of its own; the test under [`update_authorization_code_grant`](#update_authorization_code_grant) inserts through it.

## `create_device_grant`

A first pairing of a device. The same plain insert, into `device_grants`; the unique `(client_id, device_name)` key refuses a second row for the same pair. Port: [`create_device_grant`](<../Grant Store/Grants Explanation.md#create_device_grant>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grants/device.rs create_device_grant}}

No unit test of its own; the test under [`update_device_grant`](#update_device_grant) inserts through it.

## `grant_by_id`

One grant by its id, whichever kind it is: the row is read off the `grants` view and rebuilt into a `Grant`. Port: [`grant_by_id`](<../Grant Store/Grants Explanation.md#grant_by_id>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grants/general.rs grant_by_id}}

A view row carries the shared columns, the kind tag and both kinds' own columns. Rebuilding it reads the tag and takes the matching column:

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grants/general.rs Grant::try_from}}

The view selects each kind's own column from that kind's table, where it is `NOT NULL`, so a row missing its own column can't arise. The check is there anyway, as is one for a row tagged as a browser pairing: either is an infrastructure error, a logged 500, never a panic.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grants/general.rs tests::create_and_fetch_round_trip}}

Any grant of either kind, inserted into its own table, comes back off the view equal to what went in.

## `all_grants`

Every grant, both kinds, oldest `granted_at` first: the Owner's approved apps and paired devices ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs GrantsReader::list}}). Port: [`all_grants`](<../Grant Store/Grants Explanation.md#all_grants>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grants/general.rs all_grants}}

A row that can't be rebuilt fails the whole read. No unit test of its own; the tests below count grants with it.

## `grant_by_client_and_redirect`

The standing consent, if any, for this app at this redirect URI: a lookup on the `authorization_code_grants` key. It is how `/oauth/authorize` decides whether a request can skip the Owner ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs GrantCoverage::resolve}}), how an approval finds the grant to fold into, and how a code redemption finds the grant id to record on its refresh family. Port: [`grant_by_client_and_redirect`](<../Grant Store/Grants Explanation.md#grant_by_client_and_redirect>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grants/authorization_code.rs grant_by_client_and_redirect}}

It reads the concrete table and returns the concrete kind, so a device grant can never satisfy it. The redirect URI is matched on its exact string. No unit test of its own; the test under the device lookup below exercises it too.

## `device_grant_by_client_and_device_name`

The pairing, if any, for this app under this device name: a lookup on the `device_grants` key. An approval finds the grant to fold a re-pairing into, and a device's token exchange finds the grant id to record on its refresh family. Port: [`device_grant_by_client_and_device_name`](<../Grant Store/Grants Explanation.md#device_grant_by_client_and_device_name>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grants/device.rs device_grant_by_client_and_device_name}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grants/general.rs tests::code_and_device_grants_coexist_per_client}}

A code grant and a device grant for the same app live side by side; each kind's lookup finds its own; a device lookup under the code grant's redirect URI finds nothing; and the cross-kind list holds both.

## `update_authorization_code_grant`

A re-approval of an app at a redirect URI it already holds a grant for. The caller has read the standing grant and folded the new approval into it with [`absorb_reapproval`](<../Domain/Grant Explanation.md#absorb_reapproval>) in the same write scope; this writes the result back. It overwrites `scopes`, `granted_at` and `patient` on the row with the grant's id, and leaves the key columns and `last_used_at` alone. Port: [`update_authorization_code_grant`](<../Grant Store/Grants Explanation.md#update_authorization_code_grant>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grants/authorization_code.rs update_authorization_code_grant}}

The read and this write share one `BEGIN IMMEDIATE` scope, which takes the write lock as it opens. Two approvals at once therefore run one after the other: the second reads the first's union and adds to it, rather than both reading the old row and one overwriting the other.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grants/authorization_code.rs tests::upsert_action_inserts_then_unions_scopes_over_sqlite}}

A first approval inserts; a second, with one scope repeated and one new, updates the same row (same id, still one grant) to the union, and its patient replaces the first.

## `update_device_grant`

A re-pairing of a device the app already holds a grant for under that name. The same write-back as for a code grant: `scopes`, `granted_at` and `patient` on the row with the grant's id, after the caller's read and fold in the same scope. Port: [`update_device_grant`](<../Grant Store/Grants Explanation.md#update_device_grant>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grants/device.rs update_device_grant}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grants/device.rs tests::upsert_action_inserts_then_unions_scopes_over_sqlite}}

Re-pairing the same device updates its one grant to the union of scopes; pairing under a different device name records a second grant.

## `delete_authorization_code_grant`

Half of the Owner revoking a grant: delete the code grant with this id, and say whether a row went. Port: [`delete_authorization_code_grant`](<../Grant Store/Grants Explanation.md#delete_authorization_code_grant>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grants/general.rs delete_authorization_code_grant}}

The revoke doesn't pick a table by kind; it runs this and [`delete_device_grant`](#delete_device_grant) both, and since ids are unique across the two tables, at most one removes a row. No unit test of its own; the test under `delete_device_grant` drives both.

## `delete_device_grant`

The other half: delete the device grant with this id, and say whether a row went. Port: [`delete_device_grant`](<../Grant Store/Grants Explanation.md#delete_device_grant>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grants/general.rs delete_device_grant}}

**Standing consent and standing credentials end together.** The revoke runs both deletes and [`expire_refresh_token_families_for_client`](<Refresh Tokens Explanation.md#expire_refresh_token_families_for_client>) in one write scope, so either the grant is gone and every refresh family the app holds has ended, or nothing changed.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grants/general.rs tests::revoke_removes_the_row_and_expires_the_clients_families}}

After the revoke the grant is gone from both the view and its own table; the app's refresh family has its deadline pulled to the revocation instant and its live token stamped spent at that instant, both rows kept; and a second revoke of the same id is a miss.
