# Same-Device Session Ender

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_session_ender.rs}}

A [same-device sign-in](<Same Device Sign In Explanation.md>) hands the browser a launch opened an Owner session. On Android that browser is a Custom Tab, which shares the user's Chrome cookies, and on a desktop it is the default browser's own tab, so the session lands where any tab on the server's domain holds it. **So an Owner session lasts only as long as the server's launch views stay open.**

- **When the server's last launch view closes**, the base ends the sessions the codes of its views signed in since they last all closed. On iOS and Android a server's views share one cookie jar: a stacked consent view's sign-in replaces the cookie the launch view under it holds, so ending a closed view's session at its own close could leave a view still open with a dead cookie. The base holds each code, a [`SameDeviceSignInCode`](<../../Domain/Same Device Sign In Codes Explanation.md#item-SameDeviceSignInCode>), across the server's runs, and ends the sessions through the run up then, with the [OAuth bindings](<../../Assembly/OAuth Bindings Explanation.md#item-SameDeviceSignInCodeMinter--end_signed_in_sessions>)' minter. Leaving the app with a view open and coming back isn't a close, and keeps them.
- **When a view closes**, its code is withdrawn: unredeemed, it is no longer redeemable, and still signing in, it signs nobody in.
- **When the server starts**, its run's start cuts off every same-device session but those of the launch views still open, whose codes the base hands [setup](<../../Assembly/Setup Explanation.md>), so the restart a return from a suspend brings on iOS keeps an open view signed in. It writes nothing for the others: the [`StaleSessionCutoff`](<../../Domain/Browser Session Explanation.md#item-StaleSessionCutoff>) setup builds leaves them no longer [live](<../../Domain/Browser Session Explanation.md#item-BrowserSession--is_live_at>), so the token verifier refuses their cookies, as it does an expired session's, and the Browsers list leaves them out. So a store that can't be written as the server starts doesn't keep it from starting. A desktop hears no close, so the base counts its views' codes until the app exits: the server's restarts keep the desktop browser signed in, and the first start after the app's next start ends its sessions. A paired browser's session isn't a launch's, and stands.

**Ending a session expires it rather than revoking it.** Its `expires_at` moves back to now: the session's own token, the cookie, stops working at once (the [token verifier](<../Session/Token Verifier Explanation.md>) refuses it), and the browser is sent to pairing until the base's next launch signs it in again. A refresh-token family an app was issued under the session isn't revoked with it, so it keeps refreshing as its client's refresh policy says. **A code forgets its session only once the expiry has landed.** When the store fails, the base drops the codes all the same: the server's next start exempts from its cutoff only the sessions of the views open then, so those sessions go stale.

## `domain::capabilities::oauth::same_device_session_ender`

### `SameDeviceSessionEnder`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_session_ender.rs SameDeviceSessionEnder}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_session_ender.rs SameDeviceSessionEnder::new}}

#### `end_sessions_signed_in_with`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_session_ender.rs SameDeviceSessionEnder::end_sessions_signed_in_with tests="tests::codes_end_only_their_own_sessions tests::ending_by_an_unredeemed_code_withdraws_it"}}
