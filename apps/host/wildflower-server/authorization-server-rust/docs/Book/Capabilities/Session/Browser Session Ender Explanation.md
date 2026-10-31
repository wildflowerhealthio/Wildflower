# Browser Session Ender

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_ender.rs}}

The browser session ender is **sign-out**: a browser ending the [browser session](<../../Domain/Browser Session Explanation.md>) it holds, from the **Sign out** button on the server's own pages. Where [logout](<Session Ender Explanation.md>) withdraws one token, sign-out withdraws the whole session, and with it **everything minted under it**: the session cookie's token, and every app token and refresh family that carries its `sid`. From then on the [token verifier](<Token Verifier Explanation.md>) refuses every token naming it. The session's [widenings](<../../Domain/Authorization Request/Session Widening Explanation.md>) still waiting for the Owner are denied with it ([`revoke_browser_session`](<../Access/Browser Sessions Explanation.md#item-revoke_browser_session>)).

It acts on the session named by the claims of the browser's own cookie, which `POST /oauth/sign-out` passes in only for a token the token verifier accepted, so **a browser can end no session but its own**. No bearer and no scope is involved. A failed write leaves the cookie in place, as the handler answers it with a `500`.

The test ends sessions named by [claims under a chosen `sid`](<../Test Fixtures Explanation.md#browser-session-ender>).

## `domain::capabilities::session::browser_session_ender`

### `BrowserSessionEnder`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_ender.rs BrowserSessionEnder}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_ender.rs BrowserSessionEnder::new}}

#### `end`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/browser_session_ender.rs BrowserSessionEnder::end tests="tests::end_revokes_only_the_named_session"}}
