# Clients

{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs}}

The `clients` table holds every app's [registration](<../Domain/Client Explanation.md>): one row per `client_id`, read back as a [`Client`](<../Domain/Client Explanation.md#item-Client>), which maps onto the row one field to one column of the same name. **The row is the registration.** Every check at `/oauth/authorize` and `/oauth/token` reads it, the Owner's approvals of an app trusted on first use write it, and boot-time [seeding](<../Assembly/Seeding Explanation.md>) rewrites the server's own clients on every boot. The row also holds the app's [refresh policy](<../Domain/Client Explanation.md#item-RefreshPolicy>), embedded in `Client` as its own struct over three columns, which only an insert and the Owner's edit write. The primary key is `client_id`, so an app has at most one registration, and every lookup goes through that key.

The three list columns hold compact JSON text: `allowed_scopes` through the shared `JsonStrings`, and `redirect_uris` and `allowed_grant_types` through two mappings only the client binds, `JsonUrls` and `JsonAllowedGrantTypes`. `kind` and `registration_source` are stored as their wire strings. The policy's two limits are nullable whole seconds, through `OptionalSeconds`, `NULL` for no limit. The tests draw clients from [`arb_client`](<Test Fixtures Explanation.md#item-tests--arb_client>), with policies from [`arb_refresh_policy`](<Test Fixtures Explanation.md#item-tests--arb_refresh_policy>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs OptionalSeconds}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs tests::stored_columns_reject_corrupt_values}}

## `db::clients`

### `impl ClientsTx for SqliteGrantTx`

The port is [`ClientsTx`](<../Grant Store/Clients Explanation.md#item-ClientsTx>).

#### `client_by_id`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs SqliteGrantTx::client_by_id tests="tests::upsert_and_fetch_round_trip"}}

#### `is_client_disabled`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs SqliteGrantTx::is_client_disabled}}

#### `upsert_client`

**An app keeps the time it was first registered, a disabled app stays disabled, and the Owner's refresh policy stands**, whoever writes its registration again: an approval that widens a disabled app's registration doesn't re-enable it, and a boot doesn't undo the Owner's limits.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs SqliteGrantTx::upsert_client tests="tests::upsert_updates_registration_but_preserves_registered_at_disable_and_refresh_policy"}}

#### `list_clients`

A fresh store isn't empty, as the migrations seed the first-party clients, so the properties run against what they upsert themselves ([`seeded_client_ids`](<Test Fixtures Explanation.md#item-tests--seeded_client_ids>)).

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs SqliteGrantTx::list_clients tests="tests::list_clients_returns_every_row_sorted_by_id"}}

#### `set_client_disabled`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs SqliteGrantTx::set_client_disabled tests="tests::set_client_disabled_round_trips_only_the_stamp tests::set_client_disabled_on_an_unknown_id_is_a_miss"}}

#### `set_client_refresh_policy`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs SqliteGrantTx::set_client_refresh_policy tests="tests::set_client_refresh_policy_writes_only_the_policy"}}

## The seeded clients

The SMART apps' clients aren't written by Rust: SQL migrations insert their rows. **These tests are the guard that the hand-written SQL decodes as a `Client`.** Several also pin a row to the app it registers, read from that app's own source, so the row and the scopes the app asks for can't drift apart unnoticed.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs tests::migrations_seed_the_smart_app_clients}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs tests::migrations_seed_the_authorization_web_client_with_the_apps_own_scopes}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs tests::migrations_narrow_the_launcher_client_to_the_apps_own_scopes}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs tests::suggested_apps_json_publishes_the_seeded_first_party_clients}}
