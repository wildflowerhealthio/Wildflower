# Same-Device Sign-In

<!-- markdownlint-disable-file link-fragments -- the item-… anchors are added when the book is built. -->

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/authority/same_device_sign_in.rs}}

The Owner's browser signs in without a password. The base, the host app on the device that runs the server, mints a one-time [same-device sign-in code](<../Domain/Same Device Sign In Codes Explanation.md>) in-process and opens `GET /oauth/sign-in` with it. **Only the base can mint a code, and the base runs on the server's own device, so redeeming one is proof the browser is on that device, and is the Owner's.**

A **redeemed same-device sign-in code** is that proof. It is the authority a same-device [browser session](<../Domain/Browser Session Explanation.md>) is started under and its [access token](<../Domain/Access Token Explanation.md>) minted under. The sign-in capability redeems it inside its write scope, then hands it to the browser-session writer to store the session and to the access-token minter to mint the token, so the session and its token land together or not at all.

## `domain::authority::same_device_sign_in`

The tests redeem codes with the [sign-in fixtures](<Test Fixtures Explanation.md#same-device-sign-in>).

### `RedeemedSameDeviceSignInCode`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/same_device_sign_in.rs RedeemedSameDeviceSignInCode}}

#### `redeem`

The one constructor. The code is [taken](<../Domain/Same Device Sign In Codes Explanation.md#item-SameDeviceSignInCodes--take>) out of the outstanding codes, so **a code redeems once**, and the session is a [new same-device session](<../Domain/Browser Session Explanation.md#item-BrowserSession--new_same_device_session>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/same_device_sign_in.rs RedeemedSameDeviceSignInCode::redeem tests="tests::a_code_redeems_once"}}

End to end, the [Same-Device Sign-In](<../Integration Tests/Same Device Sign In Explanation.md>) tests hold the same at `/oauth/sign-in`: a code signs in once, and an unknown code signs nobody in.

#### `session`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/same_device_sign_in.rs RedeemedSameDeviceSignInCode::session tests="tests::a_redeemed_code_names_the_browser_session_client_and_the_owner_s_grant"}}

#### `client_id` and `token_scopes`

What the [token entitlement](<Token Entitlement Explanation.md>) reads off the proof.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/same_device_sign_in.rs RedeemedSameDeviceSignInCode::client_id}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/same_device_sign_in.rs RedeemedSameDeviceSignInCode::token_scopes}}
