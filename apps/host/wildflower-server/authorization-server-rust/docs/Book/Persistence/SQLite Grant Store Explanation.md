# SQLite Grant Store

{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs}}

`SqliteGrantStore` is the [Grant Store](<../Grant Store Explanation.md>) port's SQLite adapter. It holds a pool of connections onto the host's shared database file, applies this crate's migrations when it is opened, and opens the port's two scopes on a connection it checks out of the pool: a read scope in autocommit, where each statement sees a committed state and no lock is held between statements, and a write scope inside `BEGIN IMMEDIATE`, which takes the write lock before its first read.

**SQLite admits one writer at a time across every connection to the file.** A second write scope's `BEGIN IMMEDIATE` waits for the first to commit, for up to the connection's busy timeout, and then fails. That is what lets a capability read a row, decide, and write it back in one write scope without another writer landing in between.

## The revocation store and lock order

The host's token revocation store, which holds the per-token denylist and each app's revocation epoch, is not in this adapter. It reads and writes through the host's shared rusqlite connection: another connection onto the same file, behind a lock of its own. **No write scope touches the revocation store.** Taking that connection's lock while holding the file's write lock risks a lock-order stall: the other connection, mid-write, can be waiting for the write lock this scope holds, and the two wait on each other until the busy timeout. So a capability reads or writes the revocation store before or after its write scope, never inside it, which is why [two operations open two scopes](<../Grant Store Explanation.md#two-scopes-in-one-operation>).

## `db::grant_store`

### `SqliteGrantStore`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs SqliteGrantStore}}

#### `new`

Boot-time [seeding](<../Assembly/Seeding Explanation.md>) calls it before its first scope. The integration harness calls it again on a running test server's pool, for a second handle that plants rows.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs SqliteGrantStore::new}}

#### `open_in_memory`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs SqliteGrantStore::open_in_memory tests="tests::open_in_memory_stores_are_independent"}}

#### `pool`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs SqliteGrantStore::pool}}

#### `connection`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs SqliteGrantStore::connection}}

#### `read`

Each statement the closure runs commits on its own.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs SqliteGrantStore::read}}

#### `write`

The closure's own error comes back unchanged, so a capability sees its flow's refusal, not a store error. Only a failure of `BEGIN`, `COMMIT` or `ROLLBACK` itself becomes the infrastructure error `grant store transaction failed`.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs SqliteGrantStore::write}}

### `ScopeError`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs ScopeError}}

### `SqliteGrantTx`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs SqliteGrantTx}}

### `MIGRATION_NAMESPACE`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs MIGRATION_NAMESPACE}}

### `MIGRATIONS`

**A migration runs once per database, so a shipped migration is never edited.** An install that already ran it never reads it again; a change lands as a new migration, which reaches fresh and upgraded installs alike. The tests hold each migration to that: each drives a database to the version just before it with [`MigrationsThrough`](<Test Fixtures Explanation.md#item-tests--MigrationsThrough>), plants the rows an install could hold, upgrades, and checks the result, often reverting the migration too, to show its `down.sql` restores what was there.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs MIGRATIONS tests="tests::migrations_are_idempotent_and_create_the_schema tests::migration_rebaselines_over_the_old_rusqlite_tables tests::migration_versions_are_unique_apart_from_the_historical_0009_pair"}}

#### The `0009` pair and its repairs

Two folders share version `0009`, and the runner records versions alone, so an install that opened while only one of them existed recorded `0009` and never ran the other. Later migrations repair each half.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0009_is_upgraded_onto_the_fhir_viewer_redirect}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_that_ran_only_the_ohif_0009_gains_the_importer_write_scopes}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_that_ran_only_the_importer_0009_gains_the_ohif_viewer_client}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::the_0009_repairs_leave_changed_rows_alone}}

#### Seeding, reshaping and re-keying clients

The first-party apps' clients are written by SQL migrations, and every later change to one, a new redirect, narrower scopes, a random id, a new name, is a migration of its own. A re-key carries what was issued to the old id with it, and a rename or a reshape leaves alone a row the Owner has changed.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0018_gains_the_lifting_app_client}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0019_drops_launch_patient_from_the_app_clients}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0020_drops_path_entries_from_redirect_uris}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0021_gains_the_health_viewer_app_client}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0024_rekeys_the_lifting_clients}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0026_loses_the_web_trace_clients}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0027_rekeys_the_site_app_clients}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0028_rekeys_the_ohif_viewer_clients}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0029_rekeys_the_fhir_sync_pebble_clients}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0031_narrows_the_launcher_client}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0031_rekeys_the_host_app_client}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0034_renames_the_plots_and_strength_clients}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0036_adds_the_app_origin_redirects}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0037_rekeys_the_browser_session_client_and_ends_owner_sessions}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0038_renames_the_strength_clients}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0040_widens_the_authorization_web_client}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0044_starts_every_client_trusted_on_first_use}}

#### Reshaping tables

A table whose shape changes is rebuilt, and every row an install could hold is carried across. The last three of these shape what the [Authorization Requests](<Authorization Requests Explanation.md>) and [Browser Sessions](<Browser Sessions Explanation.md>) pages describe: the session kinds' names, the limited page's own status, and the split of one request table into one per flow.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0023_keeps_its_launches_and_admits_any_client}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0039_backfills_browser_session_last_seen}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0041_ends_its_sessionless_code_flow}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0042_acknowledges_every_existing_request}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0043_claims_redeemed_requests_and_drops_the_rest}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0045_renames_the_browser_session_kinds}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0046_gives_the_limited_page_its_own_status}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0047_splits_the_authorization_requests}}
