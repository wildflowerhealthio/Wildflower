# Browser Session Ender

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_ender.rs}}

The browser session ender is **sign-out**: a browser ending the [browser session](<../../Domain/Browser Session Explanation.md>) it holds, from the **Sign out** button on the server's own pages. Where [logout](<Session Ender Explanation.md>) withdraws one token, sign-out withdraws the whole session, and with it **everything minted under it**: the session cookie's token, and every app token and refresh family that carries its `sid`.

It acts on the session named by the claims of the browser's own cookie. Its caller, `POST /oauth/sign-out`, gets those claims from [`carried_browser_session`](<../../HTTP/Browser Session Cookie Explanation.md#carried_browser_session>), which returns them only for a browser-session token the [token verifier](<Token Verifier Explanation.md#verify>) accepts, so **a browser can end no session but its own**. No bearer and no scope is involved.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_ender.rs BrowserSessionEnder}}

The ender holds only the store. The handler acquires it as `Live<LiveBrowserSessionEnder>` (see the [session bindings](<../../Assembly/Session Bindings Explanation.md>)).

## Test fixtures

`claims` builds claims for the `browsers` subject under the `sid` the test chooses, or none.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_ender.rs tests::claims}}

## `new`

Built over a store handle.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_ender.rs BrowserSessionEnder::new}}

No unit test of its own; the test under [`end`](#end) builds one.

## `end`

**Revoke, at `now`, the browser session the claims' `sid` names**, in one write scope ([`revoke_browser_session`](<../../Grant Store/Browser Sessions Explanation.md#revoke_browser_session>)). The session row is kept and stamped revoked; from then on the token verifier refuses every token naming it. A session already revoked keeps its first revocation time, and claims with no `sid` end nothing. A failed write is an infrastructure error, which the handler answers with a `500` that leaves the cookie in place.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_ender.rs BrowserSessionEnder::end}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_ender.rs tests::end_revokes_only_the_named_session}}

With two Owner sessions stored, ending one by its `sid` and then ending claims with no `sid` leaves the first revoked and the other standing.

Exercised end to end by [`signing_out_revokes_the_cookie_s_session_and_clears_it`](<../../Integration Tests/Browser Sessions Explanation.md#signing_out_revokes_the_cookie_s_session_and_clears_it>) and [`signing_out_without_a_standing_session_still_clears_the_cookie`](<../../Integration Tests/Browser Sessions Explanation.md#signing_out_without_a_standing_session_still_clears_the_cookie>).
