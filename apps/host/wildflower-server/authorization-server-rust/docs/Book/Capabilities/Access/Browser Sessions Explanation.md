# Browser Sessions

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs}}

Every browser the server has signed in holds a [browser session](<../../Domain/Browser Session Explanation.md>): a same-device session from the Owner's own sign-in, or a paired session from a pairing. The Owner's list of browsers shows the live ones and signs one out. **Revoking a session ends everything minted under it**: every access token and refresh family carries the `sid` of the session it was minted in, and a token or family whose session is revoked is refused. Revoking a session also denies the [session widenings](<../../Domain/Authorization Request/Session Widening Explanation.md>) it asked for that still wait for the Owner, in the same write: a revoked browser can never collect one, so the Owner isn't asked about it.

## `domain::capabilities::access::browser_sessions`

### `browser_sessions_reader_scopes`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs browser_sessions_reader_scopes}}

### `browser_sessions_revoker_scopes`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs browser_sessions_revoker_scopes}}

### `BrowserSessionView`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs BrowserSessionView}}

### `BrowserSessionsReader`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs BrowserSessionsReader}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs BrowserSessionsReader::new}}

#### `list_live`

The session is [live](<../../Domain/Browser Session Explanation.md#item-BrowserSession--is_live_at>) under the [stale-session cutoff](<../../Domain/Browser Session Explanation.md#item-StaleSessionCutoff>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs BrowserSessionsReader::list_live tests="tests::the_list_holds_the_live_sessions_and_marks_the_caller_s"}}

### `revoke_browser_session`

The one revocation the Owner's revoke and the browser's own [sign-out](<../Session/Browser Session Ender Explanation.md>) share.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs RevokedBrowserSession}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs revoke_browser_session}}

### `BrowserSessionsRevoker`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs BrowserSessionsRevoker}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs BrowserSessionsRevoker::new}}

#### `revoke`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs BrowserSessionsRevoker::revoke tests="tests::revoke_ends_a_standing_session_and_misses_anything_else tests::revoke_denies_the_session_s_pending_widenings"}}
