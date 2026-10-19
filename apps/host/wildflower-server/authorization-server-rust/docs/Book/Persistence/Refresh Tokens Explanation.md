# Refresh Tokens

{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs}}

A [refresh family](<../Domain/Refresh Token Explanation.md>) is two tables. `refresh_token_families` holds what every link in the chain shares, once per family: the app, the scopes, the patient, the deadline, the hash of the code that started it, the grant behind it, the browser session. `refresh_tokens` holds one row per link, keyed by the hash of the token; the token itself is never stored. A link's `family_id` is a foreign key to its family, enforced (the pool turns `foreign_keys` on for every connection), so **no link can exist without its family**.

**Ending a family never deletes it.** Each expiry below (for a replayed link, the app revoking its token, the Owner revoking a grant, a replayed code) pulls the family's `expires_at` back to the moment it ended and stamps its unspent link spent at the same moment. The rows stay, so a link presented later still resolves to its dead family and is refused for that reason. Only the retention sweep deletes, once a family has been dead long enough.

The family's `grant_id` is a soft reference with no foreign key: revoking a grant deletes the grant and keeps its families. The family table is indexed on `client_id` and `authorization_code_hash`, which the bulk expiries below match on, on `sid`, which the browser-session sweep asks about, and on `grant_id`; the link table on `family_id`.

The nine methods are the `RefreshTokensTx` port on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/db/grant_store.rs SqliteGrantTx}}. The four that touch both tables run their two statements in a nested transaction, which inside a write scope's `BEGIN IMMEDIATE` is a savepoint: both statements land or neither does.

## Test fixtures

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs arb_family}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs arb_token_in_family}}

Any family (with no browser session), and any link, spent or not, in the named family.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs seed_family_with_token}}

A family and its first link, written as the two inserts the writer runs, each in its own write scope.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs sample_family}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs sample_token}}

A family for an app, live for 90 days, and an unspent link in a family.

## `insert_refresh_token_family_row`

Starting a family: a plain insert of the family row. {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/refresh_family_writer.rs RefreshFamilyWriter::start_family}} runs it and then inserts the first link, in the same write scope. Port: [`insert_refresh_token_family_row`](<../Grant Store/Refresh Tokens Explanation.md#insert_refresh_token_family_row>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens.rs SqliteGrantTx::insert_refresh_token_family_row}}

No unit test of its own; every test below seeds through it.

## `insert_refresh_token`

Adding a link to a family: the family's first, or the successor a rotation hands out after spending the link before it. A plain insert; the foreign key refuses a link whose family doesn't exist. Port: [`insert_refresh_token`](<../Grant Store/Refresh Tokens Explanation.md#insert_refresh_token>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens.rs SqliteGrantTx::insert_refresh_token}}

A link with no family would read later as an unknown token, so replaying it would end nothing; the foreign key makes that a failed write instead.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs insert_refresh_token_rejects_orphan_without_family}}

A link naming a family that doesn't exist fails the write with an infrastructure error whose source names the foreign-key constraint.

## `refresh_token_with_family_by_hash`

What a presented refresh token is: its link and its family, in one join on the link's hash. Spent links resolve too; telling a live link from a replayed one, and a live family from an ended one, is the caller's job ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ValidatedRefreshToken::validate}}). Port: [`refresh_token_with_family_by_hash`](<../Grant Store/Refresh Tokens Explanation.md#refresh_token_with_family_by_hash>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens.rs SqliteGrantTx::refresh_token_with_family_by_hash}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs insert_and_fetch_round_trip}}

Any family and any link in it, inserted and read back by the link's hash, come back equal to what went in.

## `stamp_refresh_token_consumed_if_live`

Spending a link. **The `consumed_at IS NULL` guard is the whole of single use**: the update sets `consumed_at` only on a row that doesn't have one yet, and reports whether exactly one row changed. Of two redemptions of the same live link, only one changes the row. Port: [`stamp_refresh_token_consumed_if_live`](<../Grant Store/Refresh Tokens Explanation.md#stamp_refresh_token_consumed_if_live>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens.rs SqliteGrantTx::stamp_refresh_token_consumed_if_live}}

A `false` doesn't say why: spent already, or never issued. [`consume_refresh_token`](<../Domain/Refresh Token Explanation.md#consume_refresh_token>) asks [`refresh_token_exists`](#refresh_token_exists) next to tell them apart.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs stamp_consumes_live_then_loses_the_guard_on_replay}}

The first stamp of a live link succeeds; a second fails the guard; and the link still exists, which is what makes the second a replay.

## `refresh_token_exists`

Whether any link, spent or not, has this hash. After a failed stamp, `true` means the link was already spent (a replay) and `false` means it was never issued. Port: [`refresh_token_exists`](<../Grant Store/Refresh Tokens Explanation.md#refresh_token_exists>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens.rs SqliteGrantTx::refresh_token_exists}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs unknown_hash_neither_stamps_nor_exists}}

A hash never issued is neither stamped nor found.

## `expire_refresh_token_family`

Ending one family: its `expires_at` becomes the given instant, and every link in it still unspent is stamped spent at that instant, so nothing in a dead family looks live. Links already spent keep the moment they were really spent. A replayed link ends its family this way ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/refresh_family_writer.rs RefreshFamilyWriter::rotate}}), and so does an app revoking its own refresh token, which skips a family already past its deadline. Port: [`expire_refresh_token_family`](<../Grant Store/Refresh Tokens Explanation.md#expire_refresh_token_family>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens.rs SqliteGrantTx::expire_refresh_token_family}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs expire_family_pulls_deadline_back_and_stamps_the_live_token}}

The family's deadline moves to the revocation instant; a link spent earlier keeps its own stamp; the unspent link is stamped at the revocation instant; both rows still resolve; and another family of the same app is untouched.

## `expire_refresh_token_families_for_client`

Ending every family an app holds, with the same expire-and-stamp. The Owner revoking a grant runs it, alongside the grant's delete, in one write scope ([`delete_device_grant`](<Grants Explanation.md#delete_device_grant>)). It spends the unspent links first, then moves the families' deadlines. Port: [`expire_refresh_token_families_for_client`](<../Grant Store/Refresh Tokens Explanation.md#expire_refresh_token_families_for_client>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens.rs SqliteGrantTx::expire_refresh_token_families_for_client}}

It matches on `client_id` alone, so a family that had already ended also gets the new instant as its deadline.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs expire_for_client_spares_other_clients}}

The app's family ends at the revocation instant, its link stamped spent at that instant; another app's family is untouched. The grant-revoke test, [`revoke_removes_the_row_and_expires_the_clients_families`](<Grants Explanation.md#delete_device_grant>), runs it inside the revoke's scope.

## `expire_refresh_token_families_for_authorization_code`

Ending the families a code started, found by the code's hash, with the same expire-and-stamp. A redemption of a code that is no longer stored runs it before refusing ([Redeemed once](<../Domain/Authorization Code Explanation.md#redeemed-once>)): **a replayed code takes down the refresh token its first redemption earned**. A code that started no family (one without `offline_access`, or one never issued) matches no row, and nothing changes. Port: [`expire_refresh_token_families_for_authorization_code`](<../Grant Store/Refresh Tokens Explanation.md#expire_refresh_token_families_for_authorization_code>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens.rs SqliteGrantTx::expire_refresh_token_families_for_authorization_code}}

No unit test of its own; [`auth_code_replay_revokes_issued_refresh_family`](<../Integration Tests/Grant Flows Explanation.md#auth_code_replay_revokes_issued_refresh_family>) replays a code and finds its family ended.

## `delete_refresh_token_families_expired_before`

The retention sweep's share of these tables, and the one place a family is deleted rather than ended. Every family whose `expires_at` is before the cutoff goes, with every link in it; links first, so the foreign key never sees a link without its family. It returns the number of families removed, not links. The cutoff is the sweep's ([`purge_expired`](<../Domain/Retention Explanation.md#purge_expired>), with [`REFRESH_TOKEN_FAMILY_RETENTION`](<../Domain/Retention Explanation.md#refresh_token_family_retention>)), not the current time. Port: [`delete_refresh_token_families_expired_before`](<../Grant Store/Refresh Tokens Explanation.md#delete_refresh_token_families_expired_before>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens.rs SqliteGrantTx::delete_refresh_token_families_expired_before}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs delete_expired_families_takes_every_generation_with_them}}

A family 91 days past its deadline, with two links, is removed with both links, against a cutoff 90 days back; the count is one.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/refresh_tokens/tests.rs delete_expired_families_spares_the_recently_dead_and_the_live}}

Against the same cutoff, a family that ended yesterday and a live one both stay, and the count is zero. **An ended family stays readable until it ages past the window.**
