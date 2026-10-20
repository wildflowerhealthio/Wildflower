# Browser Sessions

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/browser_sessions.rs}}

The `browser_sessions` table holds every [browser session](<../Domain/Browser Session Explanation.md>) the server has started: the Owner's signed-in browser and each paired one. **A session is revoked by stamping it, never by deleting it**, because everything minted under it carries its `sid`, and the token verifier and a refresh must still be able to tell that the session ended. That is also why a `sid` with no row counts as revoked. Rows go only in the [retention sweep](<../Domain/Retention Explanation.md#item-purge_expired>), once nothing they minted can still be live: a session a live refresh family names is kept.

The table's companion, `session_shortfall_acknowledgements`, records per session the apps it has gone on past the [limited page](<../Domain/Authorization Request/Code Request Explanation.md>) for: the page a browser sees when an app asks for more than the session holds. Continue records it, in the same write scope as the request's [acknowledgement](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--acknowledge_session_shortfall>), and only once that acknowledgement has landed. **Once the person at the browser has gone on for an app, that app's later requests from the same browser skip the page.**

`last_seen_at` moves two ways. The server accepting the session's cookie passes `seen_before` as `now` less [`LAST_SEEN_RESOLUTION`](<../Domain/Browser Session Explanation.md#item-LAST_SEEN_RESOLUTION>), so the column is written at most once per resolution. A refresh family under the session rotating passes `now` for both, so it always moves unless a later use is already recorded.

## `domain::grant_store::browser_sessions`

### `BrowserSessionsTx`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/browser_sessions.rs BrowserSessionsTx}}
