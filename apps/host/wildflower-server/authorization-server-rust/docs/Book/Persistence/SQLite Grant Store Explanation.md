# SQLite Grant Store

{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs}}

`SqliteGrantStore` is the [Grant Store](<../Grant Store Explanation.md>) port's SQLite adapter. It holds a pool of connections onto the host's shared database file, applies this crate's migrations when it is opened, and opens the port's two scopes on a connection it checks out of the pool.

The two scopes map onto SQLite like this:

| Scope                                            | On SQLite                                | What it guarantees                                                                                             |
| ------------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [`read`](<../Grant Store Explanation.md#read>)   | One connection, in autocommit            | Each statement sees a committed state. No lock is held between statements, so two reads may see two states.    |
| [`write`](<../Grant Store Explanation.md#write>) | One connection, inside `BEGIN IMMEDIATE` | The write lock is taken before the first read, so a read that decides a write sees the row the write lands on. |

**SQLite admits one writer at a time across every connection to the file.** A second write scope's `BEGIN IMMEDIATE` waits for the first to commit, for up to the connection's busy timeout, and then fails. That is what lets a capability read a row, decide, and write it back in one write scope without another writer landing in between.

## `SqliteGrantStore`

The store is the pool and nothing else. The host builds one pool for the whole app, onto the same file its other slices use, and hands each slice a clone. Each connection the pool opens sets a busy timeout of five seconds and turns foreign keys on. Diesel's connection API takes `&mut`, so a scope checks a connection out for its whole closure rather than sharing one.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs SqliteGrantStore}}

## `new`

Opens the store over the host's pool: checks one connection out, applies every pending migration on it under this crate's namespace, and returns it to the pool. Boot-time [seeding](<../Assembly/Seeding Explanation.md#open_and_seed_store>) calls it before its first scope. The integration harness calls it again on a running test server's pool, for a second handle that plants rows.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs SqliteGrantStore::new}}

No unit test of its own; the migration tests below drive the same runner directly.

## `open_in_memory`

A store over a private, freshly migrated in-memory database, for tests. Every pooled connection shares the one in-memory database, and each call gets a database of its own.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs SqliteGrantStore::open_in_memory}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::open_in_memory_stores_are_independent}}

A key written into one store is not seen by another: the isolation every store test relies on.

## `pool`

The pool itself, for tests only. A test that proves a column mapping rejects a corrupt stored value uses it to tamper with the row through raw SQL.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs SqliteGrantStore::pool}}

No unit test of its own; the signing keys' [`corrupt_values_json_is_a_typed_read_error`](<Signing Keys Explanation.md#all_signing_keys>) is one that uses it.

## `connection`

The first step of every scope: check a connection out of the pool. A checkout that fails, because the pool is exhausted for longer than its timeout or a connection can't be opened, is the port's opaque infrastructure error.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs SqliteGrantStore::connection}}

## `SqliteGrantTx`

What a scope hands its closure: the one checked-out connection, borrowed for the scope. Every port primitive is implemented on it, each concern's trait in that concern's file, beside its table. Code outside `db` can name the type, as the adapter's `Tx`, but reaches nothing on it except through those traits.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs SqliteGrantTx}}

## `read`

Checks a connection out and runs the closure on it in autocommit. Each statement the closure runs commits on its own. Port: [`read`](<../Grant Store Explanation.md#read>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs SqliteGrantStore::read}}

No unit test of its own.

## `write`

Checks a connection out and runs the closure inside diesel's `immediate_transaction`: `BEGIN IMMEDIATE`, then `COMMIT` when the closure returns `Ok`, `ROLLBACK` when it returns `Err`. **The closure's own error comes back unchanged**, so a capability sees its flow's refusal, not a store error. Only a failure of `BEGIN`, `COMMIT` or `ROLLBACK` itself becomes the infrastructure error `grant store transaction failed`. A refusal that must keep what the scope wrote, a spent code or a stamped poll, is an `Ok` outcome, so it commits. Port: [`write`](<../Grant Store Explanation.md#write>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs SqliteGrantStore::write}}

Diesel's transaction runner needs its error type to convert from a diesel error, whatever error the closure speaks. `ScopeError` is that type: it keeps the closure's error and diesel's apart so `write` can unwrap each.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs ScopeError}}

No unit test of its own.

## The revocation store and lock order

The token revocation store, which holds the per-token denylist and each client's revocation epoch, is not in this adapter. It reads and writes through the host's shared rusqlite connection: another connection onto the same file, behind a lock of its own. **No write scope touches the revocation store.** Taking that connection's lock while holding the file's write lock risks a lock-order stall: the other connection, mid-write, can be waiting for the write lock this scope holds, and the two wait on each other until the busy timeout.

So a capability reads the revocation store before or after its write scope, never inside it. The refresh-token exchange is the one place that needs both: it validates the token, its client's epoch included, in a `read` scope, then re-checks the store-only facts inside the `write` scope that rotates, because the family may have ended in between ([`exchange_refresh_token`](<../Capabilities/OAuth/Token Exchanger Explanation.md#exchange_refresh_token>), [`ValidatedRefreshToken`](<../Authority/Redemption Explanation.md#validatedrefreshtoken>)). Writes to it run outside any write scope too: revoking a grant bumps its client's epoch between the read that finds the grant and the write that deletes it, and revoking an access token denylists it after the scope that looked for a refresh token has committed.

## `MIGRATION_NAMESPACE`

The name this crate's migrations are recorded under in the shared database. The runner keeps one row per applied `(namespace, version)`, so this crate's `0001` and another diesel slice's `0001` are different migrations. The name is `gatekeeper`, the one existing databases record these migrations under.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs MIGRATION_NAMESPACE}}

## `MIGRATIONS`

The crate's `migrations/` directory, compiled in: one `<version>_<name>/` folder per migration, each with an `up.sql` and a `down.sql`. Opening a store applies every migration whose version isn't yet recorded under the namespace, oldest first, each in its own transaction together with the row that records it.

**A migration runs once per database, so a shipped migration is never edited.** An install that already ran it never reads it again; a change lands as a new migration, which reaches fresh and upgraded installs alike. The tests below hold each migration to that: each drives a database to the version just before it, plants the rows an install could hold, upgrades, and checks the result, often reverting the migration too, to show its `down.sql` restores what was there.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs MIGRATIONS}}

## Test fixtures

`MigrationsThrough` is the embedded migrations cut off at a version, so a test can drive a database to the state an install was in before a later migration ran.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::MigrationsThrough}}

`MigrationsThroughOnly0009` is the migrations through `0009`, keeping only the one `0009` folder it names. Two folders share version `0009`, and the runner records versions alone, so an install that opened while only one of them existed recorded `0009` and never ran the other. It asserts it names exactly one folder, so a typo can't make both run and pass the repair tests vacuously.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::MigrationsThroughOnly0009}}

`Name` and `OptionalName` read one text column, aliased `name`, from a raw query; `OptionalName` for a nullable one.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::Name}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::OptionalName}}

`column_for_client` reads one column of one client row; `allowed_scopes_of` reads a client's stored scope array.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::column_for_client}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::allowed_scopes_of}}

## Opening a database

### `migrations_are_idempotent_and_create_the_schema`

**Opening a database twice changes nothing the second time, and the full schema exists.** The second run skips every recorded version, and every table and the `grants` view are there.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::migrations_are_idempotent_and_create_the_schema}}

### `migration_rebaselines_over_the_old_rusqlite_tables`

**`0001` drops the old tables by name and builds the schema fresh, copying nothing.** Applied over a database holding an old-shape `grants` table with a row in it, it succeeds, and `grants` is then an empty view.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::migration_rebaselines_over_the_old_rusqlite_tables}}

### `migration_versions_are_unique_apart_from_the_historical_0009_pair`

**Every migration has a version of its own, except the two `0009` folders.** A second folder under a version an install has already recorded would be skipped there, while a fresh database runs it, so no other test would notice.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::migration_versions_are_unique_apart_from_the_historical_0009_pair}}

## The `0009` pair and its repairs

### `an_install_already_at_0009_is_upgraded_onto_the_fhir_viewer_redirect`

**A redirect change reaches an install through a new migration, not an edit.** At `0009` the OHIF viewer's client holds `0009`'s redirects exactly as they shipped; `0010` moves it to `/ohif-viewer/fhir-viewer`. Since `/authorize` matches a redirect exactly, an install left on the old one could not launch the viewer.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0009_is_upgraded_onto_the_fhir_viewer_redirect}}

### `an_install_that_ran_only_the_ohif_0009_gains_the_importer_write_scopes`

**An install that ran only the OHIF `0009` gets the Importer's write scopes from `0015`.** Before, the Importer holds the narrower set the other `0009` would have widened; after `0015`, it holds the write scopes.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_that_ran_only_the_ohif_0009_gains_the_importer_write_scopes}}

### `an_install_that_ran_only_the_importer_0009_gains_the_ohif_viewer_client`

**An install that ran only the Importer `0009` gets the OHIF viewer's client from `0016`.** Before, there is no `ohif-viewer` row, so `0010`'s redirect update matched nothing; after `0016`, the client exists with its `fhir-viewer` redirect and its scopes.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_that_ran_only_the_importer_0009_gains_the_ohif_viewer_client}}

### `the_0009_repairs_leave_changed_rows_alone`

**A repair only touches a row still in the state it repairs.** Both clients' scopes changed after `0013`; after the repairs, both keep the changed set.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::the_0009_repairs_leave_changed_rows_alone}}

## Seeding a new client

### `an_install_already_at_0018_gains_the_lifting_app_client`

**A client seeded by a later migration reaches an install that ran every earlier one.** Through `0018` there is no `lifting-app` client; `0019` adds it with its exact redirects and scopes.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0018_gains_the_lifting_app_client}}

### `an_install_already_at_0021_gains_the_health_viewer_app_client`

**`0022` adds the `health-viewer-app` client to an install at `0021`**, with its exact redirect and scopes.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0021_gains_the_health_viewer_app_client}}

## Reshaping client registrations

### `an_install_already_at_0019_drops_launch_patient_from_the_app_clients`

**`0020` moves the Medications and Lifting clients onto picking the patient in the app.** Both lose `launch/patient`, and Medications gains `system/Patient.rs` for its picker. Reverting `0020` restores `0019`'s sets.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0019_drops_launch_patient_from_the_app_clients}}

### `an_install_already_at_0020_drops_path_entries_from_redirect_uris`

**`0021` leaves only absolute redirects.** Every `"/"` path entry goes, including one planted between two absolute redirects, whose order is kept; a client with no path entry is untouched. After the remaining migrations, every client row decodes as a [`Client`](<../Domain/Client Explanation.md>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0020_drops_path_entries_from_redirect_uris}}

### `an_install_already_at_0031_narrows_the_launcher_client`

**`0032` narrows the launcher's client to the scopes the launcher asks for.** Reverting `0032` restores the wider set.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0031_narrows_the_launcher_client}}

### `an_install_already_at_0036_adds_the_app_origin_redirects`

**`0037` puts each hosted app's own origin in front of the `wildflowerhealth.io` redirect it held; a client whose redirects the Owner changed keeps them.** Reverting `0037` restores every list.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0036_adds_the_app_origin_redirects}}

### `an_install_already_at_0040_widens_the_authorization_web_client`

**`0041` adds `wildflower/BrowserSession.rd` to the Wildflower Authorization client's scopes; a client whose scopes the Owner changed keeps them.** Reverting `0041` restores the earlier set.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0040_widens_the_authorization_web_client}}

### `an_install_already_at_0044_starts_every_client_trusted_on_first_use`

**`0045` adds `clients.registration_source`, with every existing client trusted on first use.** Seeding marks the clients it owns server-defined on the next boot. Reverting `0045` drops the column.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0044_starts_every_client_trusted_on_first_use}}

## Re-keying, renaming and removing clients

### `an_install_already_at_0024_rekeys_the_lifting_clients`

**`0025` gives the Lifting clients random ids, and what was issued to them follows.** The production and dev clients are gone under their old ids and present under the new ones; the production redirect moves to `/lifting/`, the dev one stays; a launch issued to the old id now names the new one. Reverting `0025` restores the old ids.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0024_rekeys_the_lifting_clients}}

### `an_install_already_at_0026_loses_the_web_trace_clients`

**`0027` deletes both Web Trace clients and what they hold.** A Web Trace refresh token goes, under the foreign key `refresh_tokens` keeps on its family; another client's token stays. The test turns foreign keys on first, as every pooled connection does.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0026_loses_the_web_trace_clients}}

### `an_install_already_at_0027_rekeys_the_site_app_clients`

**`0028` gives the site's app clients random ids.** Each production client takes its new id and its redirect moves to its product's path; each dev client takes its new id and keeps its redirect; a launch follows its client; the Synthetic Data Loader gains a production client. Reverting `0028` restores the ids and redirects and removes that client.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0027_rekeys_the_site_app_clients}}

### `an_install_already_at_0028_rekeys_the_ohif_viewer_clients`

**`0029` gives the OHIF viewer's clients random ids**, keeping their redirects; a launch follows. Reverting `0029` restores the old ids.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0028_rekeys_the_ohif_viewer_clients}}

### `an_install_already_at_0029_rekeys_the_fhir_sync_pebble_clients`

**`0030` gives the FHIR Sync for Pebble clients random ids**, keeping their redirects; a launch follows. Reverting `0030` restores the old ids.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0029_rekeys_the_fhir_sync_pebble_clients}}

### `an_install_already_at_0031_rekeys_the_host_app_client`

**`0033` re-keys the host app's client and its grants**, so no row under the old `wildflower-host` id lingers beside the one seeding upserts. The client is named `Wildflower Host` and a device grant of it follows. Reverting `0033` restores the old id.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0031_rekeys_the_host_app_client}}

### `an_install_already_at_0034_renames_the_plots_and_strength_clients`

**`0035` renames a client only while it still holds its seeded name.** The Plots and Strength clients take their products' names; a dev client renamed `My lifts` keeps it. Reverting `0035` restores the seeded names.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0034_renames_the_plots_and_strength_clients}}

### `an_install_already_at_0037_rekeys_the_browser_session_client_and_ends_owner_sessions`

**`0038` re-keys the browser-session client in every table that names a client, and ends every standing Owner session, so the Owner signs in again.** A session already revoked keeps its revocation time, and an approved browser's session stands. The ended session's `revoked_at` is in diesel's chrono text encoding. The request column `requested_by_owner_browser` becomes `decidable_in_requesting_browser`. Reverting `0038` restores the old id and the old column name.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0037_rekeys_the_browser_session_client_and_ends_owner_sessions}}

### `an_install_already_at_0038_renames_the_strength_clients`

**`0039` renames the Strength clients to Wildflower Strength while they hold the names `0035` wrote.** Run once with the dev client at `Strength (Dev)`, which is renamed, and once at `My lifts`, which is kept. Reverting `0039` restores the earlier names.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0038_renames_the_strength_clients}}

## Reshaping tables

### `an_install_already_at_0023_keeps_its_launches_and_admits_any_client`

**`0024` makes a launch context's client optional without losing a launch.** The launch stored at `0023` survives with its client and patient; a launch with no client and no patient can be stored; a launch with a patient and no client is refused.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0023_keeps_its_launches_and_admits_any_client}}

### `an_install_already_at_0039_backfills_browser_session_last_seen`

**`0040` adds `browser_sessions.last_seen_at`, each session's set to its `created_at`, keeping the rest of the row.** The revoked session keeps its `revoked_at` and name, and the rebuilt table still refuses a kind other than the two. Reverting `0040` drops the column.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0039_backfills_browser_session_last_seen}}

### `an_install_already_at_0041_ends_its_sessionless_code_flow`

**`0042` ends what the code flow minted outside a browser session.** A live refresh family with no session expires now, and its unconsumed token is stamped consumed at that time; a token already consumed keeps its time. A code with no session is deleted, and a pending code request with no session expires. A family already expired keeps its times; a family minted in a session or by the device flow keeps going, as do the code and request made in a session and the device request. A code with no session can no longer be stored. Reverting `0042` makes a code's `sid` nullable again.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0041_ends_its_sessionless_code_flow}}

### `an_install_already_at_0042_acknowledges_every_existing_request`

**`0043` adds `authorization_requests.session_shortfall_acknowledged`, with every existing request, of either flow, acknowledged**, so none is hidden from the Owner. Reverting `0043` drops the column and the `session_shortfall_acknowledgements` table.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0042_acknowledges_every_existing_request}}

### `an_install_already_at_0043_claims_redeemed_requests_and_drops_the_rest`

**`0044` retires the stored `expired` status.** An `expired` device request that carries its granted scopes, one a poll redeemed, becomes `claimed`; every other `expired` request is deleted, and so is a code request with no `sid`. A pending request in a session stays. The `code_challenge_method` column goes. Reverting `0044` stores the claim as `expired` again and brings the column back, `S256` on the code request and NULL on the device one.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs tests::an_install_already_at_0043_claims_redeemed_requests_and_drops_the_rest}}
