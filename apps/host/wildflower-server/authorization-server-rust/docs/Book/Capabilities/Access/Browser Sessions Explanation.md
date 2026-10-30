# Browser Sessions

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs}}

Every browser the server has signed in holds a [browser session](<../../Domain/Browser Session Explanation.md>): a same-device session from the Owner's own sign-in, or a paired session from a pairing. The Owner's list of browsers shows the live ones and signs one out. **Revoking a session ends everything minted under it**: every access token and refresh family carries the `sid` of the session it was minted in, and a token or family whose session is revoked is refused.

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

The session is [live](<../../Domain/Browser Session Explanation.md#item-BrowserSession--is_live_at>) under the [run's start](<../../Domain/Browser Session Explanation.md#item-RunStart>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs BrowserSessionsReader::list_live tests="tests::the_list_holds_the_live_sessions_and_marks_the_caller_s"}}

### `BrowserSessionsRevoker`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs BrowserSessionsRevoker}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs BrowserSessionsRevoker::new}}

#### `revoke`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/browser_sessions.rs BrowserSessionsRevoker::revoke tests="tests::revoke_ends_a_standing_session_and_misses_anything_else"}}
