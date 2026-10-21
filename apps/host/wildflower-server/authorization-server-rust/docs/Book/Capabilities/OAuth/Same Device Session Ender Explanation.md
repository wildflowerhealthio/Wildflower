# Same-Device Session Ender

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_session_ender.rs}}

A [same-device sign-in](<Same Device Sign In Explanation.md>) hands the browser a launch opened an Owner session. On Android that browser is a Custom Tab, which shares the user's Chrome cookies, and on a desktop it is the default browser's own tab, so the session lands where any tab on the server's domain holds it. **So an Owner session lasts only as long as the launch view that started it and the server run that issued it.**

- **When the view closes**, the base ends the session its sign-in code started. The [sign-in codes](<../../Domain/Same Device Sign In Codes Explanation.md>) remember, in memory, which session each redeemed code started, and the base holds the code, a `SameDeviceSignInCode` from the [OAuth bindings](<../../Assembly/OAuth Bindings Explanation.md>). Only a close ends it: leaving the app with the view open and coming back doesn't, unless the server starts again meanwhile.
- **When the server starts**, [setup](<../../Assembly/Setup Explanation.md>) ends every same-device session. A desktop hears no close, so this is what ends its sessions. A paired browser's session isn't a launch's, and stands.

**Ending a session expires it rather than revoking it.** Its `expires_at` moves back to now: the session's own token, the cookie, stops working at once (the [token verifier](<../Session/Token Verifier Explanation.md>) refuses it), and the browser is sent to pairing until the base's next launch signs it in again. A refresh-token family an app was issued under the session isn't revoked with it, so it keeps refreshing as its client's refresh policy says.

## `domain::capabilities::oauth::same_device_session_ender`

### `SameDeviceSessionEnder`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_session_ender.rs SameDeviceSessionEnder}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_session_ender.rs SameDeviceSessionEnder::new}}

#### `end_session_signed_in_with`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_session_ender.rs SameDeviceSessionEnder::end_session_signed_in_with tests="tests::a_code_ends_only_its_own_session tests::a_code_that_signed_nobody_in_ends_nothing"}}

#### `end_every_session`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_session_ender.rs SameDeviceSessionEnder::end_every_session tests="tests::ending_every_session_expires_the_same_device_ones_only"}}
