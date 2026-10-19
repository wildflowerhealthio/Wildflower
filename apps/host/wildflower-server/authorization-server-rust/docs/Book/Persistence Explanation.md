# Persistence

{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/shared.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/test_support.rs}}

This part is the SQLite adapter behind the [Grant Store](<Grant Store Explanation.md>) port. The domain asks the port for two kinds of scope, a [`read`](<Grant Store Explanation.md#read>) and a [`write`](<Grant Store Explanation.md#write>), and for single-statement primitives inside them, one trait per table. This part answers each of those with SQL against the host's shared database file.

**The adapter decides nothing.** A primitive reports absence and conflict through its return type, an `Option` or a `bool`, and fails only with the opaque infrastructure error. What a missing row or a lost race means is decided in the capabilities. What the adapter does own is the guard that keeps a primitive safe when two callers race: a conditional `UPDATE … RETURNING` only one of them can win, a primary key, a `CHECK` on a table. Each page in this part names the guard behind each primitive.

The domain's row types are the diesel rows. `Client`, `SigningKey`, `LaunchContext` and the rest derive diesel's `Queryable`, `Selectable` and `Insertable` where they are defined, and name their table there. The adapter holds the `table!` declarations those derives point at, the column mappings a domain field needs to reach a TEXT column, and the trait implementations.

## Where things live

[`SqliteGrantStore`](<Persistence/SQLite Grant Store Explanation.md#sqlitegrantstore>) holds the connection pool, applies the migrations and opens the two scopes. Each concern's file holds its `table!`, its column mappings and its port trait, implemented on [`SqliteGrantTx`](<Persistence/SQLite Grant Store Explanation.md#sqlitegranttx>), the handle a scope gives its closure.

| File                           | Tables                                                          | Port trait                |
| ------------------------------ | --------------------------------------------------------------- | ------------------------- |
| `db/clients.rs`                | `clients`                                                       | `ClientsTx`               |
| `db/browser_sessions.rs`       | `browser_sessions`, `session_shortfall_acknowledgements`        | `BrowserSessionsTx`       |
| `db/authorization_requests.rs` | `authorization_requests`                                        | `AuthorizationRequestsTx` |
| `db/launch_contexts.rs`        | `launch_contexts`                                               | `LaunchContextsTx`        |
| `db/grants/`                   | `authorization_code_grants`, `device_grants`, the `grants` view | `GrantsTx`                |
| `db/authorization_codes.rs`    | `authorization_codes`                                           | `AuthorizationCodesTx`    |
| `db/refresh_tokens.rs`         | `refresh_token_families`, `refresh_tokens`                      | `RefreshTokensTx`         |
| `db/signing_keys.rs`           | `signing_keys`                                                  | `SigningKeysTx`           |

The schema lives in the crate's `migrations/` directory, one `<version>_<name>/` folder per migration holding an `up.sql` and a `down.sql`. The migrations are compiled into the binary and applied when the store is opened; [`MIGRATIONS`](<Persistence/SQLite Grant Store Explanation.md#migrations>) says how.

## Column mappings

SQLite stores lists, URLs and enums as TEXT. A domain row keeps its field as the domain type (`Vec<String>`, `Url`, `GrantType`) and plugs a mapping in with `#[diesel(serialize_as = …, deserialize_as = …)]`. **A read parses the stored text, so a corrupt or out-of-domain value is a typed read error, never a panic and never a silently wrong value.** The [Signing Keys](<Persistence/Signing Keys Explanation.md#all_signing_keys>), [Authorization Codes](<Persistence/Authorization Codes Explanation.md>) and [Authorization Requests](<Persistence/Authorization Requests Explanation.md>) pages each have a test that tampers with a stored row to show it.

A mapping only one concern binds lives in that concern's file. The ones here are bound by two or more.

## `json_text_column`

Defines a newtype that binds its inner value as compact JSON in a TEXT column and parses it back on read. There is one newtype per inner shape: `JsonStrings` here, `JsonSigningKeyValues` beside the signing keys, and others beside their tables.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/shared.rs json_text_column}}

No unit test of its own.

## `text_enum_column`

Maps a domain enum through a TEXT column by its wire string, and parses it back on read. The enum carries diesel's `AsExpression` and `FromSqlRow` derives on its definition in `domain`; this macro adds only the bind and the read. The one enum mapped here is `GrantType`, the flow discriminant that both `authorization_requests` and the `grants` view carry.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/shared.rs text_enum_column}}

No unit test of its own.

## `JsonStrings`

A list of strings, mostly scopes, as a JSON array in TEXT, made by `json_text_column`. Clients, browser sessions, authorization requests, authorization codes, grants and refresh-token families bind it.

## `UrlText`

A URL as its canonical string. A read re-parses it. Authorization requests, authorization codes and the authorization-code grant bind it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/shared.rs UrlText}}

No unit test of its own.

## Property-test generators

Each concern's round-trip property tests write a generated row and read it back unchanged. The generators here draw only values that survive that trip.

## `arb_timestamp`

A timestamp between 2000 and 2065, built from a whole number of milliseconds, so it reads back exactly from SQLite's text encoding.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/test_support.rs arb_timestamp}}

## `arb_opt_timestamp`

A timestamp or none, for a nullable column, so both branches are drawn.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/test_support.rs arb_opt_timestamp}}

## `arb_url`

An `http` or `https` URL built from parts that already parse. A host label the URL parser still refuses is filtered out rather than drawn.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/test_support.rs arb_url}}

## Pages in this part

- [SQLite Grant Store](<Persistence/SQLite Grant Store Explanation.md>): the pool, the migrations, and how the two scopes map onto SQLite transactions.
- [Clients](<Persistence/Clients Explanation.md>): the registered apps.
- [Browser Sessions](<Persistence/Browser Sessions Explanation.md>): the browsers the server has let in, and the acknowledgements of a session's shortfall.
- [Authorization Requests](<Persistence/Authorization Requests Explanation.md>): the parked requests of every flow, and their transitions.
- [Launch Contexts](<Persistence/Launch Contexts Explanation.md>): the SMART `launch` values, each consumed once.
- [Grants](<Persistence/Grants Explanation.md>): the standing approvals, one table per kind and a view across them.
- [Authorization Codes](<Persistence/Authorization Codes Explanation.md>): the one-minute codes.
- [Refresh Tokens](<Persistence/Refresh Tokens Explanation.md>): the refresh families and the tokens rotated within them.
- [Signing Keys](<Persistence/Signing Keys Explanation.md>): the RSA keys tokens are signed with.
