# Clients

{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs}}

The `clients` table holds every app's [registration](<../Domain/Client Explanation.md>): one row per `client_id`, read back as a `Client`. **The row is the registration.** Every check at `/oauth/authorize` and `/oauth/token` reads it, the Owner's approvals of an app trusted on first use write it, and boot-time seeding rewrites the server's own clients on every boot. The primary key is `client_id`, so an app has at most one registration, and every lookup here goes through that key.

`Client` maps onto the row one field to one column of the same name (`client_id`, `name`, `kind`, `redirect_uris`, `allowed_scopes`, `allowed_grant_types`, `secret_hash`, `registered_at`, `disabled_at`, `registration_source`); it derives diesel's `Queryable`, `Selectable` and `Insertable` itself. The three list columns hold compact JSON text: `allowed_scopes` through the shared `JsonStrings`, `redirect_uris` and `allowed_grant_types` through two mappings only the client binds, `JsonUrls` (absolute URLs) and `JsonAllowedGrantTypes` (the wire `grant_type` strings). `kind` and `registration_source` are stored as their wire strings. Each mapping parses on read, so a stored value outside the domain fails the read; it never decodes to a different client.

## Column mappings

**A corrupt row fails its read.** Each case tampers one column of the seeded `growth_chart` row with raw SQL: malformed JSON, a string that isn't a URL, a path where an absolute URL belongs, an unknown grant type, an unknown `kind`. Each makes `client_by_id` answer `Err`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs tests::stored_columns_reject_corrupt_values}}

## Test fixtures

The property tests draw a client from `arb_client`: an id, a printable name, either kind, one to three redirects, up to four scopes, an optional secret hash, a registration time and an optional disable stamp, and either registration source. It always allows every grant type. The timestamps and URLs come from the shared strategies on the [Persistence](<../Persistence Explanation.md>) page, which round-trip through SQLite unchanged.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs tests::arb_client}}

A fresh store isn't empty: the migrations seed the first-party clients. `seeded_client_ids` lists them, so a property can stay clear of a seeded id or compare against the seeds.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs tests::seeded_client_ids}}

## `client_by_id`

**The registration an app's `client_id` names, or `None` when the app has none.** A missing row is an answer, not an error: an app trusted on first use has no row until the Owner first approves it. The query is a primary-key lookup. A row that is there but doesn't decode is an error (see [Column mappings](#column-mappings)).

Port: [`client_by_id`](<../Grant Store/Clients Explanation.md#client_by_id>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs SqliteGrantTx::client_by_id}}

### What it looks like

Whatever is upserted reads back unchanged, for any client the strategy draws.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs tests::upsert_and_fetch_round_trip}}

## `upsert_client`

**Write an app's registration: insert it, or overwrite its policy if the app is already registered.** One `INSERT … ON CONFLICT (client_id) DO UPDATE` sets `name`, `kind`, `redirect_uris`, `allowed_scopes`, `allowed_grant_types`, `secret_hash` and `registration_source` from the new value. It never writes `registered_at` or `disabled_at` over an existing row, and never deletes the row. So **an app keeps the time it was first registered, and a disabled app stays disabled**, whoever writes its registration again.

Two writers use it. Boot-time seeding rewrites the server-defined clients on every boot, so their rows match the code. The approval writer creates the row of an app trusted on first use, or widens it; an approval that widens a disabled app's registration doesn't re-enable it.

Port: [`upsert_client`](<../Grant Store/Clients Explanation.md#upsert_client>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs SqliteGrantTx::upsert_client}}

### What it looks like

A client is registered at second 1000 and disabled at 1500, then written again renamed, with other scopes, a later `registered_at`, no disable and the server-defined source. The name, scopes and source change; the registration time and the disable stay as they were.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs tests::upsert_updates_policy_but_preserves_registration_and_disable}}

## `list_clients`

**Every registration, ordered by `client_id`**: the Owner's list of apps. Disabled apps are in it, with their `disabled_at` set.

Port: [`list_clients`](<../Grant Store/Clients Explanation.md#list_clients>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs SqliteGrantTx::list_clients}}

### What it looks like

The list is the seeds plus whatever the test upserts under fresh ids, each exactly once, sorted by `client_id`, each upserted row reading back unchanged.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs tests::list_clients_returns_every_row_sorted_by_id}}

## `set_client_disabled`

**Disable an app (`Some(at)`) or enable it again (`None`), answering whether the app is registered.** The `UPDATE` sets `disabled_at` alone, by primary key. The redirects, scopes, secret and registration time aren't written, so **an app enabled again comes back with the registration it had**. An unknown `client_id` matches no row: the answer is `false`, and no row is created.

Port: [`set_client_disabled`](<../Grant Store/Clients Explanation.md#set_client_disabled>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs SqliteGrantTx::set_client_disabled}}

### What it looks like

Disabling then enabling an upserted client changes `disabled_at` alone, and each step answers `true`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs tests::set_client_disabled_round_trips_only_the_stamp}}

An id that isn't registered answers `false` and leaves the list as it was.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs tests::set_client_disabled_on_an_unknown_id_is_a_miss}}

## The seeded clients

The SMART apps' clients aren't written by Rust: SQL migrations insert their rows. **These tests are the guard that the hand-written SQL decodes as a `Client`**, since a malformed JSON column or timestamp would fail `client_by_id`. Several also pin a row to the app it registers, read from that app's own source, so the row and the scopes the app asks for can't drift apart unnoticed.

Every seeded SMART client (two sample apps and the first-party apps) is present, public, without a secret, with at least one scope, redirect and grant type, and a list of ids must not be registered. The rest of the test, cut from the excerpt, pins each first-party app's exact redirects (the app's own origin and its path on `wildflowerhealth.io`), scopes and grant types.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs tests::migrations_seed_the_smart_app_clients from="let store" through="for client_id in [" from="for retired in ["}}

Wildflower Authorization's client allows exactly the scopes the app asks for: the test reads the app's `src/config.ts` and finds the client id and the row's scope string in it. The client is public, enabled, and returns to the app's two published roots.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs tests::migrations_seed_the_authorization_web_client_with_the_apps_own_scopes}}

The launcher's row allows exactly the scope string its `src/sign-in.ts` declares. The launcher is trusted on first use, so its request is what bounds it; a wider row would be a ceiling nothing uses.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs tests::migrations_narrow_the_launcher_client_to_the_apps_own_scopes}}

The marketing site publishes each first-party app's client registration in `suggested_apps.json`, for a server that registers the app itself. Every first-party entry there must match its seeded row: public, no secret, the same scopes and grant types, and every redirect it lists registered.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/clients.rs tests::suggested_apps_json_publishes_the_seeded_first_party_clients}}
