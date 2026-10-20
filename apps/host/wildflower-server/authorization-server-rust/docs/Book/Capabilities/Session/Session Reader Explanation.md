# Session Reader

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_reader.rs}}

The session reader is a caller reading back **its own** session: the scopes the token it presented carries, and, for a token minted under a [browser session](<../../Domain/Browser Session Explanation.md>), when that session ends. Every answer comes from the caller's verified claims or from the one browser session their `sid` names, so the read discloses nothing about anyone else, and it needs no scope.

That matters for who calls it. The device-login screen reads the session's real scopes to seed its scope picker, and the server's own pages read the browser session's expiry to show how long the browser stays signed in. A caller that has just been refused for a missing scope is exactly the one that needs to read what it does hold. `GET /authorization/session` builds one, and so does the browsers list, which reads the caller's `sid` to mark the caller's own browser.

The test reads [claims under a stored session or none](<../Test Fixtures Explanation.md#session-reader>).

## `domain::capabilities::session::session_reader`

### `SessionReader`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_reader.rs SessionReader}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_reader.rs SessionReader::new}}

#### `sid`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_reader.rs SessionReader::sid}}

#### `scopes`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_reader.rs SessionReader::scopes}}

#### `browser_session_expires_at`

The test reads `sid` and `scopes` back alongside the expiry.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/session_reader.rs SessionReader::browser_session_expires_at tests="tests::the_browser_session_expiry_is_the_named_session_s"}}
