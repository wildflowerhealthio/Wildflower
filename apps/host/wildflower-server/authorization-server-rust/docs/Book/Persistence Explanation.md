# Persistence

{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/shared.rs}}

This part is the SQLite adapter behind the [Grant Store](<Grant Store Explanation.md>) port. The domain asks the port for two kinds of scope, a read and a write ([`GrantStore`](<Grant Store Explanation.md#item-GrantStore>)), and for primitives inside them, one trait per table. This part answers each of those with SQL against the host's shared database file.

**The adapter decides nothing.** A primitive reports absence and conflict through its return type, an `Option` or a `bool`, and fails only with the opaque infrastructure error. What a missing row or a lost race means is decided in the capabilities. What the adapter does own is the guard that keeps a primitive safe when two callers race: a conditional `UPDATE … RETURNING` only one of them can win, a primary key, a partial unique index, a `CHECK`. Each page in this part names the guard behind each primitive, and its tests hold the guard against a real database.

The domain's row types are the diesel rows. [`Client`](<Domain/Client Explanation.md#item-Client>), [`SigningKey`](<Domain/Signing Key Explanation.md#item-SigningKey>), [`LaunchContext`](<Domain/Launch Context Explanation.md#item-LaunchContext>) and the rest derive diesel's `Queryable`, `Selectable` and `Insertable` where they are defined, and name their table there. The adapter holds the `table!` declarations those derives point at, the column mappings a domain field needs to reach a TEXT column, and the trait implementations. The two kinds of row whose shape differs from the domain's, a [grant](<Persistence/Grants Explanation.md>) read off the cross-kind view and an [authorization request](<Persistence/Authorization Requests Explanation.md>) of either table, have row types of their own here, converted on the way in and out.

## Where things live

[`SqliteGrantStore`](<Persistence/SQLite Grant Store Explanation.md>) holds the connection pool, applies the migrations and opens the two scopes. Each concern's file holds its `table!`, its column mappings and its port trait, implemented on `SqliteGrantTx`, the handle a scope lends its closure:

- [Clients](<Persistence/Clients Explanation.md>), `db/clients.rs`: the `clients` table, the registered apps.
- [Browser Sessions](<Persistence/Browser Sessions Explanation.md>), `db/browser_sessions.rs`: `browser_sessions`, and `session_shortfall_acknowledgements` beside it.
- [Authorization Requests](<Persistence/Authorization Requests Explanation.md>), `db/authorization_requests/`: `code_authorization_requests` for code requests, `user_code_requests` for device requests and browser pairings, and `session_widening_requests` for session widenings.
- [Launch Contexts](<Persistence/Launch Contexts Explanation.md>), `db/launch_contexts.rs`: `launch_contexts`, each consumed once.
- [Grants](<Persistence/Grants Explanation.md>), `db/grants/`: `authorization_code_grants`, `device_grants`, and the `grants` view across them.
- [Authorization Codes](<Persistence/Authorization Codes Explanation.md>), `db/authorization_codes.rs`: `authorization_codes`, the one-minute codes.
- [Refresh Tokens](<Persistence/Refresh Tokens Explanation.md>), `db/refresh_tokens.rs`: `refresh_token_families` and the `refresh_tokens` rotated within them.
- [Signing Keys](<Persistence/Signing Keys Explanation.md>), `db/signing_keys.rs`: `signing_keys`, the RSA keys tokens are signed with.
- [Test Fixtures](<Persistence/Test Fixtures Explanation.md>): the generators and helpers the adapter's tests share.

The schema lives in the crate's `migrations/` directory, one `<version>_<name>/` folder per migration holding an `up.sql` and a `down.sql`, compiled into the binary and applied when the store is opened ([migrations](<Persistence/SQLite Grant Store Explanation.md#item-MIGRATIONS>)).

## `db::shared`

SQLite stores lists, URLs and enums as TEXT. A domain row keeps its field as the domain type (`Vec<String>`, `Url`, `FlowType`) and plugs a mapping in with `#[diesel(serialize_as = …, deserialize_as = …)]`. **A read parses the stored text, so a corrupt or out-of-domain value is a typed read error, never a panic and never a silently wrong value.** Each table's page has a test that tampers with a stored row to show it.

A mapping only one concern binds lives in that concern's file; the ones here are bound by two or more. The two macros generate every mapping in the adapter, shared and per-concern alike.

### `json_text_column`

It makes `JsonStrings` here, a list of strings (scopes, mostly) bound by clients, browser sessions, both request tables, codes, grants and refresh families, and one newtype per other shape beside its table.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/shared.rs json_text_column}}

### `text_enum_column`

Here it maps [`FlowType`](<Domain/Authorization Request Explanation.md#item-FlowType>), which `user_code_requests.flow` and the `grants` view's `grant_type` both carry.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/shared.rs text_enum_column}}

### `UrlText`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/shared.rs UrlText}}
