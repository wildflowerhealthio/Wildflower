# Refresh Tokens

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/refresh_tokens.rs}}

Two tables hold an app's standing credentials, the [refresh families](<../Domain/Refresh Token Explanation.md>): `refresh_token_families`, one row per authorization (its app, scopes, deadline, and the browser session, code and grant it came from), and `refresh_tokens`, one row per token in the family's rotation, keyed by the token's hash.

Two rules live here. **A token is consumed once**: the guarded stamp lets exactly one presentation of a live token through, and the existence probe after a failed stamp tells a replay, which ends the family, from a token never issued ([`consume_refresh_token`](<../Domain/Refresh Token Explanation.md#item-consume_refresh_token>)). **A family is ended, not deleted**: ending pulls its deadline back to now and stamps its live token consumed, keeping the lineage readable, and only the [retention sweep](<../Domain/Retention Explanation.md#item-purge_expired>) deletes it.

A family ends four ways, all through the same expire-and-stamp: a replayed token, the app revoking its own refresh token, the Owner revoking a grant (every family the app holds, in the same write scope as the grant's delete, so **consent and the credentials it earned end together**), and a code presented again after it was redeemed (every family that code started).

## `domain::grant_store::refresh_tokens`

### `RefreshTokensTx`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/refresh_tokens.rs RefreshTokensTx}}
