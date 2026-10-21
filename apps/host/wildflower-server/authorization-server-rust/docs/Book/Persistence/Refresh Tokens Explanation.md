# Refresh Tokens

{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs}}

A [refresh family](<../Domain/Refresh Token Explanation.md>) is two tables. `refresh_token_families` holds what every link in the chain shares, once per family: the app, the scopes, the patient, the deadline, the hash of the code that started it, the grant behind it, the browser session. `refresh_tokens` holds one row per link, keyed by the hash of the token; the token itself is never stored. A link's `family_id` is a foreign key to its family, enforced, as the pool turns `foreign_keys` on for every connection, so **no link can exist without its family**.

**Ending a family never deletes it.** Each expiry below, for a replayed link, the app revoking its token, the Owner revoking a grant, or a replayed code, pulls the family's `expires_at` back to the moment it ended and stamps its unspent link spent at the same moment. The rows stay, so a link presented later still resolves to its dead family and is refused for that reason. Only the retention sweep deletes, once a family has been dead long enough.

The family's `grant_id` is a soft reference with no foreign key: revoking a grant deletes the grant and keeps its families. The family table is indexed on `client_id` and `authorization_code_hash`, which the bulk expiries match on, on `sid`, which the browser-session sweep asks about, and on `grant_id`; the link table on `family_id`. The methods that touch both tables run their two statements in a nested transaction, which inside a write scope's `BEGIN IMMEDIATE` is a savepoint: both land or neither does.

The tests are in a file of their own, `refresh_tokens/tests.rs`, and each is shown under the primitive it holds. They draw families from [`arb_family`](<Test Fixtures Explanation.md#item-arb_family>) and plant them with [`seed_family_with_token`](<Test Fixtures Explanation.md#item-seed_family_with_token>).

## `db::refresh_tokens`

### `impl RefreshTokensTx for SqliteGrantTx`

The port is [`RefreshTokensTx`](<../Grant Store/Refresh Tokens Explanation.md#item-RefreshTokensTx>).

#### `insert_refresh_token_family_row`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens.rs SqliteGrantTx::insert_refresh_token_family_row}}

#### `insert_refresh_token`

A link with no family would read later as an unknown token, so replaying it would end nothing; the foreign key makes that a failed write instead.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens.rs SqliteGrantTx::insert_refresh_token}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs insert_refresh_token_rejects_orphan_without_family}}

#### `refresh_token_with_family_by_hash`

Telling a live link from a replayed one, and a live family from an ended one, is the caller's job ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ValidatedRefreshToken::validate}}).

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens.rs SqliteGrantTx::refresh_token_with_family_by_hash}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs insert_and_fetch_round_trip}}

#### `stamp_refresh_token_consumed_if_live`

A `false` doesn't say why: spent already, or never issued. [`consume_refresh_token`](<../Domain/Refresh Token Explanation.md#item-consume_refresh_token>) asks `has_refresh_token` next to tell them apart.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens.rs SqliteGrantTx::stamp_refresh_token_consumed_if_live}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs stamp_consumes_live_then_loses_the_guard_on_replay}}

#### `has_refresh_token`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens.rs SqliteGrantTx::has_refresh_token}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs unknown_hash_neither_stamps_nor_exists}}

#### `set_refresh_token_family_expires_at`

A rotation moves the deadline to where its app's policy puts it; this is the write, nothing more.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens.rs SqliteGrantTx::set_refresh_token_family_expires_at}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs set_expires_at_moves_only_that_family_s_deadline}}

#### `expire_refresh_token_family`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens.rs SqliteGrantTx::expire_refresh_token_family}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs expire_family_pulls_deadline_back_and_stamps_the_live_token}}

#### `expire_refresh_token_families_for_client`

It runs alongside a grant's delete in one write scope ([`delete_device_grant`](<Grants Explanation.md#item-delete_device_grant>)). It matches on `client_id` alone, so a family that had already ended also gets the new instant as its deadline.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens.rs SqliteGrantTx::expire_refresh_token_families_for_client}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs expire_for_client_spares_other_clients}}

#### `expire_refresh_token_families_for_authorization_code`

A redemption of a code no longer stored runs it before refusing: **a replayed code takes down the refresh token its first redemption earned**. Its test is an integration test, which replays a code and finds its family ended ([Grant Flows](<../Integration Tests/Grant Flows Explanation.md>)).

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens.rs SqliteGrantTx::expire_refresh_token_families_for_authorization_code}}

#### `delete_refresh_token_families_expired_before`

The cutoff is the sweep's, [`purge_expired`](<../Domain/Retention Explanation.md#item-purge_expired>) with [`REFRESH_TOKEN_FAMILY_RETENTION`](<../Domain/Retention Explanation.md#item-REFRESH_TOKEN_FAMILY_RETENTION>). **An ended family stays readable until it ages past the window.**

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens.rs SqliteGrantTx::delete_refresh_token_families_expired_before}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs delete_expired_families_takes_every_generation_with_them}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs delete_expired_families_spares_the_recently_dead_and_the_live}}
