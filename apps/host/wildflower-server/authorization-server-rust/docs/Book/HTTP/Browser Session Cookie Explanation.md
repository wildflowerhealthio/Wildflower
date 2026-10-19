# The Browser Session Cookie

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs}}

A browser the server has let in holds its [browser session](<../Domain/Browser Session Explanation.md>) in a cookie, `__Host-browser_session`. **The cookie's value is the browser's access token itself**, issued to the browser-session client and naming the session as its `sid`. Nothing about the cookie is stored server-side: a restart doesn't sign the browser out, and what does is whatever the [token verifier](<../Capabilities/Session/Token Verifier Explanation.md#verify>) refuses, a revoked `jti`, a revoked subject, or a revoked browser session.

The server sets the cookie when it signs a browser in: the Owner's at same-device sign-in, an approved browser's on the pairing page's poll. From then on two readers use it:

- **The host's cookie-to-bearer layer**, in front of everything, turns the cookie of a request from the server's own pages into that request's bearer, so the gates check it like any other token. It asks this file whether the session still stands, records the use, and clears the cookie once the session has ended.
- **The front door** reads it directly: `/oauth/authorize` sends a browser with no standing session to pairing and issues an app's code under the session it finds; the wait page's status poll and the session-shortfall routes read it to know whose browser is asking; the start limit reads it to decide whether to defer; sign-out reads it to know which session to end.

A browser can also hold the FHIR web UI's `hfs_session`. When both ride a request, the host's layer presents `hfs_session`'s bearer, unless the page names the browser session with the [`SESSION_HEADER`](#session_header).

## `BROWSER_SESSION_COOKIE`

**The cookie's name.** The `__Host-` prefix makes a browser accept it only when it is `Secure`, has `Path=/` and no `Domain`, so the cookie is this server's alone, set over `https`, and no sibling subdomain behind the same relay can set or shadow it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs BROWSER_SESSION_COOKIE}}

No unit test of its own; the cookie tests below spell it out.

## `SESSION_HEADER`

**Which session a request from the server's own pages acts in**, for a browser holding more than one session cookie. A page that acts as the browser's session (the consent card, and the wait page's check for it) sends `wildflower-session: browser`. The host's layer then presents the browser session's token, or none, and never falls back to `hfs_session`'s. Any other value, or no header, gets the layer's default.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs SESSION_HEADER}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs BROWSER_SESSION_HEADER_VALUE}}

No unit test here; the host's layer is tested in `wildflower-server-rust`, and [`the_wait_page_checks_the_browser_session`](<../Integration Tests/Wait Page Explanation.md#the_wait_page_checks_the_browser_session>) checks the wait page sends it.

## `browser_session_set_cookie`

**The `Set-Cookie` that signs a browser in**: the session token as the value, `Secure` and `Path=/` for the prefix, `HttpOnly` so no script on any page reads the token, `SameSite=Lax` so another site's subrequests don't carry it, and a `Max-Age` of exactly the token's lifetime, so the cookie and the token end together.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs browser_session_set_cookie}}

Both it and the clearing cookie are written by one private helper:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs browser_session_cookie}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs tests::the_cookie_has_exactly_the_browser_session_attributes}}

The Owner's eight-hour and a paired browser's twenty-four-hour token give the same attributes, with `Max-Age` of 28800 and 86400 seconds.

Exercised end to end by [`the_cookie_holds_an_eight_hour_owner_token`](<../Integration Tests/Same Device Sign In Explanation.md#the_cookie_holds_an_eight_hour_owner_token>) and [`a_browser_pairs_and_holds_a_day_long_session_with_the_approved_scopes`](<../Integration Tests/Browser Pairing Explanation.md#a_browser_pairs_and_holds_a_day_long_session_with_the_approved_scopes>).

## `browser_session_clearing_set_cookie`

**The `Set-Cookie` that signs a browser out of its cookie**: the same name and attributes, an empty value, `Max-Age=0`. The cookie is `HttpOnly`, so only the server can clear it; sign-out sends this, and so does the host's layer once a session has ended.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs browser_session_clearing_set_cookie}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs tests::the_clearing_cookie_has_the_same_attributes_and_no_age}}

The clearing cookie is the set cookie with no value and no age.

Exercised end to end by [`signing_out_revokes_the_cookie_s_session_and_clears_it`](<../Integration Tests/Browser Sessions Explanation.md#signing_out_revokes_the_cookie_s_session_and_clears_it>).

## Test fixtures

The tests below verify real tokens against the fake store. `mint` and `mint_scoped` sign a token for this server's origin, issued to the client the test names, under a `sid` or none, with `system/*.cruds` or the scopes given.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs tests::mint}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs tests::mint_scoped}}

`cookie_headers` builds request headers with one `Cookie` header per string given.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs tests::cookie_headers}}

## `standing_browser_session`

**Does this cookie value still hold a browser session?** The answer is the session token's verified claims, whose `sid` names the session, or `None` once it has ended. A token holds a standing session only when the token verifier accepts it **and** it was issued to the browser-session client **and** it names a session. Any other token, even one the gates would accept, holds none: an app's token copied into the cookie doesn't make a browser session. A token the verifier refuses as rejected or revoked is `None`, not an error; only a store that can't be read is an error, so the caller can tell "signed out" from "can't tell".

The host's cookie-to-bearer layer calls this with the cookie's value.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs standing_browser_session}}

The decision is a private helper over any store, which the tests drive directly:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs standing_session_claims}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs tests::only_a_browser_session_token_holds_a_browser_session}}

A browser-session client's token under a stored session holds it; another client's token, with or without that session's `sid`, and a browser-session client's token with no `sid`, hold none.

This crate's integration tests reach the same decision through [`carried_browser_session`](#carried_browser_session); the host's layer, which calls this function, is tested in `wildflower-server-rust`.

## `carried_browser_session`

**The standing browser session a request carries**, read from its `Cookie` headers: no cookie is `None`, and a cookie is judged as [`standing_browser_session`](#standing_browser_session) judges it. This is what the front door's routes and the start limit call; they hold a `LiveTokenVerifier` already, so they pass it in.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs carried_browser_session}}

Finding the cookie among the request's headers is its own helper. It parses every `Cookie` header, so a browser sending its cookies in one header or several is read the same, and matches the name exactly:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs browser_session_token}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs tests::the_session_token_is_read_from_among_the_browser_s_cookies}}

The token is found alone, among other cookies in one header, and across separate headers; a cookie whose name only starts the same, another cookie, and no cookie give nothing.

Exercised end to end by [`signing_out_without_a_standing_session_still_clears_the_cookie`](<../Integration Tests/Browser Sessions Explanation.md#signing_out_without_a_standing_session_still_clears_the_cookie>) and [`a_browser_without_a_session_is_sent_to_pairing_even_with_a_standing_grant`](<../Integration Tests/Session Required Explanation.md#a_browser_without_a_session_is_sent_to_pairing_even_with_a_standing_grant>).

## `can_decide_consents`

**Can this browser decide app requests on its own consent card?** Only when its session's scopes cover both reading a request ([`consent_reader_scopes`](<../Capabilities/Access/Consents Explanation.md#consent_reader_scopes>), `wildflower/AuthorizationRequest.r`) and deciding it ([`consent_decider_scopes`](<../Capabilities/Access/Consents Explanation.md#consent_decider_scopes>), `wildflower/AuthorizationRequest.u`). The Owner's session can; a browser paired with less can't. This is a necessary condition, not the whole one: whether a given request goes to the card also depends on the session holding that request's approval scopes, which `/oauth/authorize` works out per request.

The start limit uses it to decide whether a start can wait to be counted: a request such a browser decides on its own card raises nothing for the Owner, so it spends nothing (see [`limit_authorization_starts`](<Middleware Explanation.md#limit_authorization_starts>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs can_decide_consents}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs tests::deciding_consents_takes_reading_and_updating_requests}}

A session holding read and update, as two scopes or one `.ru`, can decide; one holding only read or only update can't.

Exercised end to end by [`a_browser_session_that_cannot_decide_consents_asks_the_gate`](<../Integration Tests/Authorization Start Limit Explanation.md#a_browser_session_that_cannot_decide_consents_asks_the_gate>).

## `record_browser_session_cookie_use`

**Tell the server the host accepted a session's cookie at `now`**, so the session's `last_seen_at` moves. The host's layer calls it after [`standing_browser_session`](#standing_browser_session) says the session stands. It builds the [browser session use recorder](<../Capabilities/Session/Browser Session Use Recorder Explanation.md#record_cookie_use>) from the state, which moves `last_seen_at` at most once every five minutes per session and writes nothing for most calls.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs record_browser_session_cookie_use}}

No unit test here; the recorder's tests cover the rule.
