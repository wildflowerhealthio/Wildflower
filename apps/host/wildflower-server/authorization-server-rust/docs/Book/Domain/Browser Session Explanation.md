# Browser Session

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/browser_session.rs}}

A **browser session** is a browser the server has let in. It is keyed by its `sid`, and **everything minted while using that browser records the `sid`**: each authorization code, access token and refresh-token family. That is what makes a browser revocable as a unit. Revoking the session ends what it earned: the token verifier refuses a token whose `sid` names a revoked session, and refresh redemption refuses a family whose `sid` does.

A browser gets a session one of two ways. The **Owner's** browser signs in on the server's own device with a same-device sign-in code. **Any other** browser pairs: it shows a code, and the Owner approves it, choosing what it may hold.

**A session's scopes cap what any app requested in it can receive.** The Owner may approve an app for more, but the code issued under the session carries only what the session also holds. A browser paired with read-only access earns no app write access, whoever approved the request. This is also why a browser pairs before it makes app requests: a code is always issued under the session its request was made in.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/browser_session.rs BrowserSession}}

| Field          | The fact it records                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `sid`          | The session's identity, and the `sid` claim of everything minted under it.                                                        |
| `kind`         | How the browser came to hold the session: the Owner's sign-in, or an approved pairing.                                            |
| `name`         | The name the browser was given when it paired. An Owner session has none.                                                         |
| `scopes`       | The session's grant: the most an app requested in this browser can be issued.                                                     |
| `expires_at`   | When the session stops letting the browser start things.                                                                          |
| `revoked_at`   | When the session was revoked, ending everything it minted.                                                                        |
| `last_seen_at` | When the session was last in use: its sign-in, the server accepting its cookie, or a refresh-token family that names it rotating. |

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/browser_session.rs BrowserSessionKind keep-docs}}

## `new_owner`

**The Owner's browser starts a session by signing in.** It gets a fresh `sid`, no name, the scopes it is signed in with, and the lifetime its caller passes. Signing in counts as a use, so `last_seen_at` starts at the sign-in. Same-device sign-in gives an Owner session the Owner's grant, for eight hours.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/browser_session.rs BrowserSession::new_owner}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/browser_session.rs tests::an_owner_session_is_unnamed_and_lasts_its_ttl}}

An Owner session is of kind `Owner`, unnamed, lasts exactly its lifetime, starts unrevoked and seen at sign-in, and two sessions never share a `sid`.

## `new_approved`

**Any other browser gets its session when the Owner approves its pairing.** The session is named for the browser, holds the scopes the Owner approved, and lasts the lifetime its caller passes. Browser pairing gives an approved session twenty-four hours.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/browser_session.rs BrowserSession::new_approved}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/browser_session.rs tests::an_approved_session_is_named_and_lasts_its_ttl}}

An approved session is of kind `Approved`, carries the browser's name and the approved scopes, lasts exactly its lifetime, and starts unrevoked.

## `is_live`

**A session is live until it expires or is revoked, whichever comes first.** It stops being live at the instant `expires_at` names. An app request is only approved into a code while the session it was made in is live; a request whose session has ended is denied instead, so the app hears `access_denied` rather than earning a code no live session bounds.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/browser_session.rs BrowserSession::is_live}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/browser_session.rs tests::a_session_is_live_until_it_expires_or_is_revoked}}

A fresh session is live at its sign-in, not live at its expiry, and a revoked one is not live even before then.

## `LONGEST_BROWSER_SESSION_TTL`

**No session lasts longer than a day, and no token the server mints outlives the longest session.** Two retention rules lean on that bound: a revoked token's `jti` is kept at least this long, and an ended session is kept this long for the tokens that may still name it (see [Retention](<Retention Explanation.md>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/browser_session.rs LONGEST_BROWSER_SESSION_TTL}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/browser_session.rs tests::every_session_is_within_the_longest_session}}

Both session lifetimes the server hands out, the Owner's and an approved browser's, are within the bound.

## `LAST_SEEN_RESOLUTION`

How finely cookie use moves `last_seen_at`: at most once every five minutes per session. A page load sends many requests, and this keeps it to one write.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/browser_session.rs LAST_SEEN_RESOLUTION}}

No unit test of its own here; {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/last_seen_throttle.rs LastSeenThrottle}} applies it.
