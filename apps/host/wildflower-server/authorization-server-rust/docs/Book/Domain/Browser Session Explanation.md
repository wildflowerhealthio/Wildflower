# Browser Session

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/browser_session.rs}}

A **browser session** is a browser the server has let in. It is keyed by its `sid`, and **everything minted while using that browser records the `sid`**: each authorization code, access token and refresh-token family. That is what makes a browser revocable as a unit: revoking the session ends what it earned.

A browser gets a session one of two ways. The **Owner's** browser, on the server's own device, signs in with a [same-device sign-in code](<Same Device Sign In Codes Explanation.md>), and its session lasts eight hours ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs SAME_DEVICE_SESSION_TTL}}), or until the launch view that signed it in closes or the server restarts, which [end it](<../Capabilities/OAuth/Same Device Session Ender Explanation.md>) by expiring it. **Any other** browser pairs: it shows a code, the Owner approves it and chooses what it may hold, and its session lasts a day ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs PAIRED_SESSION_TTL}}).

**A session's scopes cap what any app requested in it can receive.** The Owner may approve an app for more, but the code issued under the session carries only what the session also [covers](<Scopes Explanation.md>). A browser paired with read-only access earns no app write access, whoever approved the request. This is also why a browser signs in or pairs before it makes app requests: a code is always issued under the session its request was made in.

## `domain::browser_session`

### `BrowserSession`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/browser_session.rs BrowserSession}}

#### `new_same_device_session`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/browser_session.rs BrowserSession::new_same_device_session tests="tests::a_same_device_session_is_unnamed_and_lasts_its_ttl"}}

#### `new_paired_session`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/browser_session.rs BrowserSession::new_paired_session tests="tests::a_paired_session_is_named_and_lasts_its_ttl"}}

#### `is_live`

An app's request is approved into a code only while the session it was made in is live. A request whose session has ended is denied instead, so the app hears `access_denied` rather than earning a code no live session bounds.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/browser_session.rs BrowserSession::is_live tests="tests::a_session_is_live_until_it_expires_or_is_revoked"}}

### `BrowserSessionKind`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/browser_session.rs BrowserSessionKind tests="tests::the_kind_is_stored_and_sent_as_its_snake_case_name"}}

### `LONGEST_BROWSER_SESSION_TTL`

[Retention](<Retention Explanation.md#item-BROWSER_SESSION_RETENTION>) keeps an ended session this long.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/browser_session.rs LONGEST_BROWSER_SESSION_TTL tests="tests::every_session_is_within_the_longest_session"}}

### `LAST_SEEN_RESOLUTION`

The [`LastSeenThrottle`](<Session Housekeeping Explanation.md#item-LastSeenThrottle>) applies it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/browser_session.rs LAST_SEEN_RESOLUTION}}
