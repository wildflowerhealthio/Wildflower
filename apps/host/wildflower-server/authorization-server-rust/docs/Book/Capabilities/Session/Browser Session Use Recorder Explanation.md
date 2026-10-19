# Browser Session Use Recorder

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_use_recorder.rs}}

The Owner's list of browsers shows when each was last in use, so the Owner can tell a browser they still use from one to revoke. That time is the session's `last_seen_at`. One of the things that moves it is the server **accepting the browser's session cookie**, and the recorder is what records that.

A browser sends its cookie on nearly every request from the server's pages, and writing on each would make every page load a database write. So **`last_seen_at` moves at most once every [`LAST_SEEN_RESOLUTION`](<../../Domain/Browser Session Explanation.md#last_seen_resolution>) (five minutes) per session.** Two things hold that. An in-memory `LastSeenThrottle` lets one use per session per window through to the store, so most calls write nothing. The store's update is itself conditional, so the window holds even when the throttle is empty after a restart.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_use_recorder.rs BrowserSessionUseRecorder}}

The recorder holds the store and the state's shared throttle. The host's cookie-to-bearer layer reaches it through [`record_browser_session_cookie_use`](<../../HTTP/Browser Session Cookie Explanation.md#record_browser_session_cookie_use>), once it has accepted a cookie.

## Test fixtures

`claims` builds claims for the `browsers` subject under the `sid` the test chooses; `last_seen` reads a stored session's `last_seen_at` back.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_use_recorder.rs tests::claims}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_use_recorder.rs tests::last_seen}}

## `new`

Built over the store and the throttle, both lifted from the state, so every request shares the one throttle.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_use_recorder.rs BrowserSessionUseRecorder::new}}

No unit test of its own; each test under [`record_cookie_use`](#record_cookie_use) builds one.

## `record_cookie_use`

**Record that the cookie holding the session the claims' `sid` names was accepted at `now`.** Claims with no `sid` name no session and record nothing. Otherwise the throttle decides: a use after one it already let through for this session within the window returns at once. A use it admits goes to [`touch_browser_session_last_seen`](<../../Grant Store/Browser Sessions Explanation.md#touch_browser_session_last_seen>), which moves `last_seen_at` to `now` unless it already moved within the window.

If the write fails, the throttle forgets the session, so the next use tries again rather than waiting out a window in which nothing was written; the failure is returned as an infrastructure error.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_use_recorder.rs BrowserSessionUseRecorder::record_cookie_use}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_use_recorder.rs tests::a_cookie_use_moves_last_seen_at_most_once_a_window}}

For a session signed in an hour ago, the first use moves `last_seen_at` to that use, a second four minutes later leaves it, and one a full window after the first moves it again.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_use_recorder.rs tests::the_update_guard_holds_the_window_across_a_restart}}

A fresh throttle, as after a restart, lets a use one minute after sign-in through, but the store's guard leaves `last_seen_at` at the sign-in.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_use_recorder.rs tests::claims_without_a_session_record_nothing}}

Claims with no `sid` succeed without touching the store.
