# Browser Session Use Recorder

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_use_recorder.rs}}

The Owner's list of browsers shows when each was last in use, so the Owner can tell a browser they still use from one to revoke. That time is the [browser session's](<../../Domain/Browser Session Explanation.md>) `last_seen_at`. One of the things that moves it is the server **accepting the browser's session cookie**, and the recorder records that, once the host's cookie-to-bearer layer has accepted a cookie.

A browser sends its cookie on nearly every request from the server's pages, and writing on each would make every page load a database write. So `last_seen_at` moves at most once every [`LAST_SEEN_RESOLUTION`](<../../Domain/Browser Session Explanation.md#item-LAST_SEEN_RESOLUTION>) per session. Two things hold that: the in-memory [`LastSeenThrottle`](<../../Domain/Session Housekeeping Explanation.md#item-LastSeenThrottle>), shared by every request, lets one use per session per window through to the store, and the store's update is itself conditional, so the window holds even when the throttle is empty after a restart.

The tests record uses named by [claims under a chosen `sid`](<../Test Fixtures Explanation.md#browser-session-use-recorder>).

## `domain::capabilities::session::browser_session_use_recorder`

### `BrowserSessionUseRecorder`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_use_recorder.rs BrowserSessionUseRecorder}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_use_recorder.rs BrowserSessionUseRecorder::new}}

#### `record_cookie_use`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_use_recorder.rs BrowserSessionUseRecorder::record_cookie_use tests="tests::a_cookie_use_moves_last_seen_at_most_once_a_window tests::the_update_guard_holds_the_window_across_a_restart tests::claims_without_a_session_record_nothing"}}
