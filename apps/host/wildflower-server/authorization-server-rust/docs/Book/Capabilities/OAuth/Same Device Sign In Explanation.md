# Same-Device Sign-In

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs}}

The Owner's own browser doesn't pair. The base app, running on the same device as the server, mints a one-time [sign-in code](<../../Domain/Same Device Sign In Codes Explanation.md>) in-process and opens `GET /oauth/sign-in?code=…&next=…` in a browser. **Only the base can mint a code, so redeeming one proves the browser is on the Owner's device.** The sign-in starts an Owner [browser session](<../../Domain/Browser Session Explanation.md#new_owner>) holding the Owner's scopes, hands the browser that session's token for its `__Host-browser_session` cookie, and sends it on to `next`.

The codes live in memory, not in the store, and redeeming one takes it out for good. So the order of the checks matters: **everything that can refuse a sign-in without the code's fault runs before the code is touched**, and a refused `next` or a disabled client leaves the code redeemable.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs SameDeviceSignIn}}

It holds the store, the outstanding codes, the places a sign-in may send a browser on to, the server's origin (the token's `iss` and `aud`), and the Owner's grant. `new` builds it from those handles, lifted from the state.

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs SameDeviceSignIn::new}}

## `OWNER_SESSION_TTL`

**An Owner session lasts a working day**, eight hours. The session and its token end together; after that the base signs the browser in again.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs OWNER_SESSION_TTL}}

## Test fixtures

`sign_in_over` builds the capability over a store and a set of codes, with the Owner's grant as `system/*.cruds wildflower/*.cruds`. `sign_in_with_a_code` adds an active signing key, the seeded browser-session client and one outstanding code, `code-1`, minted at the given instant, and returns the key so a test can verify the token.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs tests::sign_in_over}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs tests::sign_in_with_a_code}}

## `sign_in`

1. **`next` must be one of the allowed places**: a path on this server, or a page under the hosted launcher, the Authorization app, or the launcher and Authorization app the host opens for this server. Anything else is refused before any scope opens.
2. A **write** scope opens. **A disabled browser-session client signs nobody in**, since every browser session's token is issued to it. It is an essential client the Owner can't disable, so only a row disabled out of band is; its row is seeded at boot, so a missing one is a store error.
3. The code is redeemed for the [`RedeemedSameDeviceSignInCode`](<../../Authority/Same Device Sign In Explanation.md#redeem>) proof. An unknown, spent or expired code is refused, the three alike. The proof carries a new Owner session holding the Owner's grant, lasting eight hours.
4. The [session writer](<../../Writers/Browser Session Writer Explanation.md#start_owner_session>) stores the session, and the [minter](<../../Writers/Access Token Minter Explanation.md#mint>) signs its token for the browser-session client, naming the session, with the same eight hours. Both land in the one scope.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs SameDeviceSignIn::sign_in}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs browser_session_client_is_disabled}}

A sign-in yields the token and where the browser goes next:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs SignedIn}}

A refusal is rendered as a local page, with no redirect:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs SignInRefusal}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs SameDeviceSignInError}}

**A failure after the code is taken spends it.** If the session can't be stored, or the token can't be minted, the scope rolls back and no session remains, but the code is already out of memory: signing in again takes a new one. A store failure reading the browser-session client comes before the code, so it leaves the code redeemable.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs tests::a_code_signs_the_owner_in_for_eight_hours}}

A good code and `next` of `/` sign in: the redirect is `/`, and the token, which this server accepts, is issued to the browser-session client, carries the Owner's scopes, and lives eight hours.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs tests::a_code_signs_in_once}}

The same code a second time is `CodeNotRedeemable`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs tests::an_expired_or_unknown_code_signs_nobody_in}}

A code never minted, and `code-1` presented at the instant its TTL runs out, are both `CodeNotRedeemable`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs tests::a_refused_next_leaves_the_code_redeemable}}

A `next` on another origin is `RedirectNotAllowed`, and the same code then signs in with `/`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs tests::a_disabled_browser_session_client_signs_nobody_in_and_leaves_the_code_redeemable}}

With the browser-session client disabled the sign-in is `BrowserSessionClientDisabled`; once it is enabled again the same code signs in.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs tests::a_missing_browser_session_client_is_a_store_error}}

Over a store without the browser-session client's row, the sign-in is a `Store` error naming the missing client, not a sign-in.

Exercised end to end by the [Same-Device Sign-In](<../../Integration Tests/Same Device Sign In Explanation.md>) tests, among them [`the_cookie_holds_an_eight_hour_owner_token`](<../../Integration Tests/Same Device Sign In Explanation.md#the_cookie_holds_an_eight_hour_owner_token>), [`a_next_anywhere_else_is_refused_and_leaves_the_code_redeemable`](<../../Integration Tests/Same Device Sign In Explanation.md#a_next_anywhere_else_is_refused_and_leaves_the_code_redeemable>) and [`a_disabled_browser_session_client_signs_nobody_in_until_re_enabled`](<../../Integration Tests/Same Device Sign In Explanation.md#a_disabled_browser_session_client_signs_nobody_in_until_re_enabled>), and by [`a_sign_in_starts_an_owner_session_its_token_names`](<../../Integration Tests/Browser Sessions Explanation.md#a_sign_in_starts_an_owner_session_its_token_names>).
