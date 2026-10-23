# Same-Device Session Ender

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_session_ender.rs}}

A [same-device sign-in](<Same Device Sign In Explanation.md>) hands the browser a launch opened an Owner session. On Android that browser is a Custom Tab, which shares the user's Chrome cookies, and on a desktop it is the default browser's own tab, so the session lands where any tab on the server's domain holds it. **So an Owner session lasts only as long as the server's launch views stay open.**

- **When the server's last launch view closes**, the base ends the sessions the codes of its views signed in since they last all closed. On iOS and Android a server's views share one cookie jar: a stacked consent view's sign-in replaces the cookie the launch view under it holds, so ending a closed view's session at its own close could leave a view still open with a dead cookie. The base holds each code, a [`SameDeviceSignInCode`](<../../Domain/Same Device Sign In Codes Explanation.md#item-SameDeviceSignInCode>), across the server's runs, and ends the sessions through the run up then, with the [OAuth bindings](<../../Assembly/OAuth Bindings Explanation.md#item-SameDeviceSignInCodeMinter--end_signed_in_sessions>)' minter. Leaving the app with a view open and coming back isn't a close, and keeps them.
- **When a view closes**, its code is withdrawn: unredeemed, it is no longer redeemable, and still signing in, it signs nobody in.
- **When the server starts**, [setup](<../../Assembly/Setup Explanation.md>) ends every same-device session but those of the launch views still open, whose codes the base hands it, so the restart a return from a suspend brings on iOS keeps an open view signed in. A desktop hears no close, so its views count no code, and the start is what ends their sessions. A paired browser's session isn't a launch's, and stands.

**Ending a session expires it rather than revoking it.** Its `expires_at` moves back to now: the session's own token, the cookie, stops working at once (the [token verifier](<../Session/Token Verifier Explanation.md>) refuses it), and the browser is sent to pairing until the base's next launch signs it in again. A refresh-token family an app was issued under the session isn't revoked with it, so it keeps refreshing as its client's refresh policy says. **A code forgets its session only once the expiry has landed**, so a store failure leaves the base holding the codes to end them again.

## `domain::capabilities::oauth::same_device_session_ender`

### `SameDeviceSessionEnder`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_session_ender.rs SameDeviceSessionEnder}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_session_ender.rs SameDeviceSessionEnder::new}}

#### `end_sessions_signed_in_with`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_session_ender.rs SameDeviceSessionEnder::end_sessions_signed_in_with tests="tests::codes_end_only_their_own_sessions tests::ending_by_an_unredeemed_code_withdraws_it"}}

#### `end_every_session_but`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_session_ender.rs SameDeviceSessionEnder::end_every_session_but tests="tests::ending_every_session_keeps_the_kept_codes_and_paired_ones"}}
