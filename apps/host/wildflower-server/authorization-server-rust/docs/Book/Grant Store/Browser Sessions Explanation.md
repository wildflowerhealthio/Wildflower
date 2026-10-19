# Browser Sessions

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/browser_sessions.rs}}

The `browser_sessions` table holds every [browser session](<../Domain/Browser Session Explanation.md>) the server has started: the Owner's signed-in browser and each paired one. **A session is revoked by stamping it, never by deleting it**, because everything minted under it carries its `sid`, and a token verifier or a refresh that finds the `sid` must still be able to tell that the session ended. Rows go only in the retention sweep, once nothing they minted can still be live.

The table's companion records, per session, the apps it has gone past [the limited page](<../Domain/Authorization Request Explanation.md#the-limited-page-and-the-race-it-creates>) for: the page a browser sees when an app asks for more than the session holds.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/browser_sessions.rs BrowserSessionsTx}}

## `insert_browser_session`

Record a session that has just started: the Owner signing in, or a pairing the Owner approved. The browser session writer is the only production path that starts one.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/browser_sessions.rs BrowserSessionsTx::insert_browser_session}}

The SQLite side: [`insert_browser_session`](<../Persistence/Browser Sessions Explanation.md#insert_browser_session>).

## `browser_session_by_sid`

The session a cookie or a token names, as stored, or `None`. It loads revoked and expired sessions too: whether the session still stands is the caller's question, answered by [`is_live`](<../Domain/Browser Session Explanation.md#is_live>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/browser_sessions.rs BrowserSessionsTx::browser_session_by_sid}}

The SQLite side: [`browser_session_by_sid`](<../Persistence/Browser Sessions Explanation.md#browser_session_by_sid>).

## `live_browser_sessions`

The sessions standing at `now`, not revoked and not expired, newest first: the Owner's list of signed-in browsers.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/browser_sessions.rs BrowserSessionsTx::live_browser_sessions}}

The SQLite side: [`live_browser_sessions`](<../Persistence/Browser Sessions Explanation.md#live_browser_sessions>).

## `browser_session_is_revoked`

Whether the session `sid` has been revoked, without loading it. The token verifier asks it of a token's `sid`, and refresh-token validation asks it of a family's. **A `sid` that names no session counts as revoked**: a session is pruned only once nothing it minted can still be live, so a missing row fails closed.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/browser_sessions.rs BrowserSessionsTx::browser_session_is_revoked}}

The SQLite side: [`browser_session_is_revoked`](<../Persistence/Browser Sessions Explanation.md#browser_session_is_revoked>).

## `revoke_browser_session`

Stamp the session revoked at `now`, ending everything minted under it. **It answers `true` only when it moved a standing session to revoked**: a second revoke, or a `sid` with no row, is `false` and changes nothing, so the first revocation's time is the one kept. The Owner revoking a browser from the list turns `false` into "no such session"; signing out ignores it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/browser_sessions.rs BrowserSessionsTx::revoke_browser_session}}

The SQLite side: [`revoke_browser_session`](<../Persistence/Browser Sessions Explanation.md#revoke_browser_session>).

## `touch_browser_session_last_seen`

Move the session's `last_seen_at` to `seen_at`, unless it was already seen after `seen_before`; `true` if it moved. The guard is a throttle the caller sets. The server accepting a session cookie passes `now - LAST_SEEN_RESOLUTION`, so it writes [at most once per resolution](<../Domain/Browser Session Explanation.md#last_seen_resolution>). A refresh family that names the session rotating passes `now` for both, so it always moves unless a later use is already recorded.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/browser_sessions.rs BrowserSessionsTx::touch_browser_session_last_seen}}

The SQLite side: [`touch_browser_session_last_seen`](<../Persistence/Browser Sessions Explanation.md#touch_browser_session_last_seen>).

## `session_shortfall_acknowledged_for_client`

Whether this browser has gone past the limited page for this app before. `/oauth/authorize` asks it when the app wants more than the session holds: **once the person at the browser has chosen to go on for an app, that app's later requests from the same browser skip the page**.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/browser_sessions.rs BrowserSessionsTx::session_shortfall_acknowledged_for_client}}

The SQLite side: [`session_shortfall_acknowledged_for_client`](<../Persistence/Browser Sessions Explanation.md#session_shortfall_acknowledged_for_client>).

## `record_session_shortfall_acknowledgement`

Record that this browser went on past the limited page for this app. It is written by Continue, in the same write scope as the request's [acknowledgement](<../Domain/Authorization Request Explanation.md#acknowledge_session_shortfall>), and only once that acknowledgement has landed. **Recording it twice changes nothing.**

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/browser_sessions.rs BrowserSessionsTx::record_session_shortfall_acknowledgement}}

The SQLite side: [`record_session_shortfall_acknowledgement`](<../Persistence/Browser Sessions Explanation.md#record_session_shortfall_acknowledgement>).

## `delete_browser_sessions_ended_before`

The retention sweep's step for sessions: delete every session that expired or was revoked before `cutoff`, **unless a refresh-token family still alive at `cutoff` names it**, so a family that outlives its session still finds the session it was minted under. A session's limited-page acknowledgements go with it. The count is how many sessions went. [`purge_expired`](<../Domain/Retention Explanation.md#purge_expired>) runs it after the refresh families' own step, in the same write scope.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/browser_sessions.rs BrowserSessionsTx::delete_browser_sessions_ended_before}}

The SQLite side: [`delete_browser_sessions_ended_before`](<../Persistence/Browser Sessions Explanation.md#delete_browser_sessions_ended_before>).
