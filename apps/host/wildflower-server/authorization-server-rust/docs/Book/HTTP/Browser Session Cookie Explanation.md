# Browser Session Cookie

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs}}

A browser the server has let in holds its [browser session](<../Domain/Browser Session Explanation.md>) in a cookie, `__Host-browser_session`. **The cookie's value is the browser's [access token](<../Domain/Access Token Explanation.md>) itself**, issued to the browser-session client and naming the session as its `sid`. Nothing about the cookie is stored server-side: what signs the browser out is whatever the [token verifier](<../Capabilities/Session/Token Verifier Explanation.md>) refuses: a revoked `jti`, a revoked subject, a revoked browser session, or, for the session's own token, an expired one. The host ends the Owner's same-device sessions by expiring them once the server's last launch view closes, and a server start expires every same-device session but those of the launch views still open; a paired browser's session lasts through a restart.

The server sets the cookie when it signs a browser in: the Owner's at same-device sign-in, an approved browser's on the pairing page's poll. From then on two kinds of reader use it:

- **The host's cookie-to-bearer layer**, in front of everything, turns the cookie of a request from the server's own pages into that request's bearer, so the gates check it like any other token. It asks this file whether the session still stands, records the use, and clears the cookie once the session has ended.
- **The front door** reads it directly: `/oauth/authorize` sends a browser with no standing session to pairing and issues an app's code under the session it finds; the wait page's status poll and the limited page's calls read it to know whose browser is asking; the start limit reads it to decide whether to defer; sign-out reads it to know which session to end.

A browser can also hold the FHIR web UI's `hfs_session`. When both ride a request, the host's layer presents `hfs_session`'s bearer, unless the page names the browser session with the [`SESSION_HEADER`](#item-SESSION_HEADER).

## `http::browser_session_cookie`

### `BROWSER_SESSION_COOKIE`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs BROWSER_SESSION_COOKIE}}

### `SESSION_HEADER`

The consent card sends it, and so does the wait page when it checks whether this browser can decide the request.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs SESSION_HEADER}}

### `BROWSER_SESSION_HEADER_VALUE`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs BROWSER_SESSION_HEADER_VALUE}}

### `browser_session_set_cookie`

The Owner's eight-hour and a paired browser's day-long token give the same attributes, and a `Max-Age` of their own lifetime, so the cookie and the token end together.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs browser_session_set_cookie tests="tests::the_cookie_has_exactly_the_browser_session_attributes"}}

### `browser_session_clearing_set_cookie`

Sign-out sends it, and so does the host's layer once a session has ended.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs browser_session_clearing_set_cookie tests="tests::the_clearing_cookie_has_the_same_attributes_and_no_age"}}

### `browser_session_cookie`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs browser_session_cookie}}

### `standing_browser_session`

**Does this cookie value still hold a browser session?** A token the verifier refuses as rejected or revoked is `None`, not an error; only a store that can't be read is an error, so the caller can tell "signed out" from "can't tell". The host's cookie-to-bearer layer calls this with the cookie's value.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs standing_browser_session}}

### `standing_session_claims`

The decision itself, over any store, which the test drives directly. Any token but a browser-session client's under a session holds none, even one the gates would accept: an app's token copied into the cookie doesn't make a browser session. The tests [mint real tokens](<Test Fixtures Explanation.md#browser-session-cookie>) and verify them against the fake store.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs standing_session_claims tests="tests::only_a_browser_session_token_holds_a_browser_session"}}

### `carried_browser_session`

What the front door's routes and the start limit call. They hold a `LiveTokenVerifier` already, so they pass it in.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs carried_browser_session}}

### `browser_session_token`

It parses every `Cookie` header, so a browser sending its cookies in one header or several is read the same, and matches the name exactly. The test builds its headers with [`cookie_headers`](<Test Fixtures Explanation.md#browser-session-cookie>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs browser_session_token tests="tests::the_session_token_is_read_from_among_the_browser_s_cookies"}}

### `can_decide_consents`

The Owner's session can; a browser paired with less can't. This is a necessary condition, not the whole one: whether a given request goes to the consent card also depends on the session holding that request's approval scopes, which `/oauth/authorize` works out per request. The start limit uses it to decide whether a start can wait to be counted (see [`limit_authorization_starts`](<Middleware Explanation.md#item-limit_authorization_starts>)).

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs can_decide_consents tests="tests::deciding_consents_takes_reading_and_updating_requests"}}

### `record_browser_session_cookie_use`

The host's layer calls it after [`standing_browser_session`](#item-standing_browser_session) says the session stands. It builds the [browser session use recorder](<../Capabilities/Session/Browser Session Use Recorder Explanation.md>) from the state, which asks the [`LastSeenThrottle`](<../Domain/Session Housekeeping Explanation.md#item-LastSeenThrottle>) first.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs record_browser_session_cookie_use}}
