# Same-Device Sign-In

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs}}

The Owner's own browser doesn't pair. The base app, running on the same device as the server, mints a one-time [sign-in code](<../../Domain/Same Device Sign In Codes Explanation.md>) in-process and opens `GET /oauth/sign-in?code=…&next=…` in a browser. **Only the base can mint a code, so redeeming one proves the browser is on the Owner's device.** The sign-in starts a same-device [browser session](<../../Domain/Browser Session Explanation.md>) holding the Owner's scopes, hands the browser that session's token for its cookie, and sends it on to `next`.

The codes live in memory, not in the store, and redeeming one takes it out for good, even when the write scope later rolls back. So **everything that can refuse a sign-in without the code's fault runs before the code is touched**, and a refused `next` or a disabled client leaves the code redeemable. A failure after the code is taken spends it: if the session can't be stored or the token can't be minted, no session remains, and signing in again takes a new code. Once the session is stored, the codes remember it by the code that started it, so the base can end it once the server's launch views have closed. A code the base withdrew while its session was being stored, as its view closed, signs nobody in: the session is expired at once and its token never handed out, so a closed view's late sign-in can't replace the cookie a view still open holds.

The redemption is the [`RedeemedSameDeviceSignInCode`](<../../Authority/Same Device Sign In Explanation.md>) proof; the [browser session writer](<../../Writers/Browser Session Writer Explanation.md>) stores the session it carries, and the [access token minter](<../../Writers/Access Token Minter Explanation.md>) signs its token.

The tests sign in over the [sign-in fixtures](<../Test Fixtures Explanation.md#same-device-sign-in>).

## `domain::capabilities::oauth::same_device_sign_in`

### `SAME_DEVICE_SESSION_TTL`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs SAME_DEVICE_SESSION_TTL}}

### `SignedIn`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs SignedIn}}

### `SameDeviceSignInError`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs SameDeviceSignInError}}

### `SignInRefusal`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs SignInRefusal}}

### `SameDeviceSignIn`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs SameDeviceSignIn}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs SameDeviceSignIn::new}}

#### `sign_in`

Where a sign-in may go next is the [sign-in destinations](<../../Domain/Same Device Sign In Codes Explanation.md#where-a-sign-in-may-send-the-browser>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs SameDeviceSignIn::sign_in tests="tests::a_code_signs_the_owner_in_for_eight_hours tests::a_sign_in_remembers_its_session_by_the_code tests::a_code_withdrawn_while_signing_in_signs_nobody_in tests::a_code_signs_in_once tests::an_expired_or_unknown_code_signs_nobody_in tests::a_refused_next_leaves_the_code_redeemable tests::a_disabled_browser_session_client_signs_nobody_in_and_leaves_the_code_redeemable tests::a_missing_browser_session_client_is_a_store_error"}}

### `is_browser_session_client_disabled`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs is_browser_session_client_disabled}}
