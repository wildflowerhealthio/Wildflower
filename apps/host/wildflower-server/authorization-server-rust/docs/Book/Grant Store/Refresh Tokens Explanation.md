# Refresh Tokens

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/refresh_tokens.rs}}

Two tables hold an app's standing credentials: `refresh_token_families`, one row per authorization (its client, scopes, absolute deadline, and the browser session, code and grant it came from), and `refresh_tokens`, one row per token in the family's rotation, keyed by the token's hash. The domain side is the [Refresh Token](<../Domain/Refresh Token Explanation.md>) page.

Two rules live here. **A token is consumed once**: the guarded stamp lets exactly one presentation of a live token through, and a second presentation is a replay that ends the family. **A family is ended, not deleted**: ending pulls its deadline back to now and stamps its live token consumed, keeping the lineage readable, and only the retention sweep deletes it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/refresh_tokens.rs RefreshTokensTx}}

## `insert_refresh_token_family_row`

Record a new family, **the row alone**. A family must never persist without its first token; pairing the two in one scope is the refresh family writer's job when it starts a family.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/refresh_tokens.rs RefreshTokensTx::insert_refresh_token_family_row}}

The SQLite side: [`insert_refresh_token_family_row`](<../Persistence/Refresh Tokens Explanation.md#insert_refresh_token_family_row>).

## `insert_refresh_token`

Record a token in an existing family: the first one when a family starts, and each successor as it rotates. An unknown family or a repeated hash fails the insert.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/refresh_tokens.rs RefreshTokensTx::insert_refresh_token}}

The SQLite side: [`insert_refresh_token`](<../Persistence/Refresh Tokens Explanation.md#insert_refresh_token>).

## `refresh_token_with_family_by_hash`

The presented token's row and its family, in one read, or `None`. **Consumed tokens resolve too**: whether the token is live or replayed is the caller's question, answered by `consumed_at`. Validating a refresh token and an app revoking its own token both start here.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/refresh_tokens.rs RefreshTokensTx::refresh_token_with_family_by_hash}}

The SQLite side: [`refresh_token_with_family_by_hash`](<../Persistence/Refresh Tokens Explanation.md#refresh_token_with_family_by_hash>).

## `stamp_refresh_token_consumed_if_live`

Stamp the token consumed at `now`, **only if it isn't already**; `true` if this call consumed it. A replayed token answers `false`. It is the guarded half of [`consume_refresh_token`](<../Domain/Refresh Token Explanation.md#consume_refresh_token>), which runs it inside a write scope so that of two concurrent presentations exactly one stamps.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/refresh_tokens.rs RefreshTokensTx::stamp_refresh_token_consumed_if_live}}

The SQLite side: [`stamp_refresh_token_consumed_if_live`](<../Persistence/Refresh Tokens Explanation.md#stamp_refresh_token_consumed_if_live>).

## `refresh_token_exists`

Whether any token, live or consumed, has this hash. Asked only after the stamp found no live row, it tells a replay (`true`, so the family is ended) from a token the server never issued (`false`, refused with no revocation).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/refresh_tokens.rs RefreshTokensTx::refresh_token_exists}}

The SQLite side: [`refresh_token_exists`](<../Persistence/Refresh Tokens Explanation.md#refresh_token_exists>).

## `expire_refresh_token_family`

End one family: pull its `expires_at` back to `now` and stamp its live token consumed at the same instant. **The two land together or not at all**, and the rows are kept. A replay ends the family this way, and so does an app revoking its own refresh token.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/refresh_tokens.rs RefreshTokensTx::expire_refresh_token_family}}

The SQLite side: [`expire_refresh_token_family`](<../Persistence/Refresh Tokens Explanation.md#expire_refresh_token_family>).

## `expire_refresh_token_families_for_client`

End every family issued to an app, the same way. It is the standing-credential half of the Owner revoking a grant, in the same write scope as the grant's delete, so **consent and the credentials it earned end together**.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/refresh_tokens.rs RefreshTokensTx::expire_refresh_token_families_for_client}}

The SQLite side: [`expire_refresh_token_families_for_client`](<../Persistence/Refresh Tokens Explanation.md#expire_refresh_token_families_for_client>).

## `expire_refresh_token_families_for_authorization_code`

End every family started from this authorization code, found by the code's hash. When a code is presented again after it was redeemed, whatever the first redemption earned is ended too (RFC 6749 §4.1.2). A code that never started a family ends nothing.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/refresh_tokens.rs RefreshTokensTx::expire_refresh_token_families_for_authorization_code}}

The SQLite side: [`expire_refresh_token_families_for_authorization_code`](<../Persistence/Refresh Tokens Explanation.md#expire_refresh_token_families_for_authorization_code>).

## `delete_refresh_token_families_expired_before`

The retention sweep's step for families: delete every family whose deadline fell before `cutoff`, with all its tokens, tokens first so the foreign key holds, and count the **families**. Ending keeps the lineage; this is where it finally goes. [`purge_expired`](<../Domain/Retention Explanation.md#purge_expired>) runs it in one write scope with the other tables' steps.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/refresh_tokens.rs RefreshTokensTx::delete_refresh_token_families_expired_before}}

The SQLite side: [`delete_refresh_token_families_expired_before`](<../Persistence/Refresh Tokens Explanation.md#delete_refresh_token_families_expired_before>).
