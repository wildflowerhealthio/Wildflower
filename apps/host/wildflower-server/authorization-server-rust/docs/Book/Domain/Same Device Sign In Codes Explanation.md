# Same-Device Sign-In Codes

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs}}

The Owner signs a browser in by asking the base, the Wildflower app on the device that runs the server. The base mints a **same-device sign-in code** in-process and opens `GET /oauth/sign-in?code=…&next=…` in a browser. Whoever presents the code there first, in time, starts a same-device [browser session](<Browser Session Explanation.md>) in that browser. Only the base can mint a code, and the base runs on the server's own device, so redeeming one stands for "this browser is on the Owner's device". The [same-device sign-in proof](<../Authority/Same Device Sign In Explanation.md>) is that redemption; this page is the codes it redeems from, and where the browser may be sent once it is signed in.

**A code is single-use, short-lived, and never stored in the clear.** Each is 256 random bits, redeemable once, for a minute. The outstanding codes live only in the server's memory and only as SHA-256 hashes: a restart drops them all, and reading the server's memory yields none.

**The set follows each code past its redemption**, by the same hash: while the session it starts is being stored, and then which session it started, until that session expires. The base holds each code it minted as a `SameDeviceSignInCode`: the code with the set of the run that minted it, and nothing of the run's store, so it outlives that run. Through it the base **withdraws** the code once the view it was opened in closes: an unredeemed code is no longer redeemable, and a code withdrawn while its session is still being stored signs nobody in, the session expired as it lands. Through it the [same-device session ender](<../Capabilities/OAuth/Same Device Session Ender Explanation.md>) finds the session to end once the server's last launch view closes, and the next run's setup the session to keep while a view is still open. A code forgets its session only once the ending has landed, so a failed ending can be tried again.

## Where a sign-in may send the browser

A sign-in URL carries a `next`: where the browser goes once its session has started. **A `next` is held to an allow-list**, so a sign-in link can't be turned into a redirect to anywhere. A `next` is allowed when it is

- a path on this server: it starts with `/` but not `//`, and still names this server's origin once resolved against it;
- a URL under the hosted launcher or the Wildflower Authorization app;
- a URL under the pages the host opens for this server, its own launcher and Authorization app: the page itself, whatever its query, or a URL within it as a folder.

Each is judged by the URL a browser would make of it, parsed as the WHATWG URL standard says, so spellings a browser reads as another host (`/\evil.example`, a tab inside `//`, `user@host`) resolve to that host here too, and are refused. **The redirect is the parsed URL re-serialized, never the raw `next`.** The sign-in checks `next` before it touches the code, so a refused `next` leaves the code redeemable.

A browser pairing's `next` is held tighter: a paired browser is only ever sent on to this server's own `/oauth/authorize`.

## `domain::same_device_sign_in_codes`

### `SameDeviceSignInCodes`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs SameDeviceSignInCodes}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs SameDeviceSignInCodes::new}}

#### `insert`

Minting a code. The base's minter, {{#code-link apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs SameDeviceSignInCodeMinter}}, calls this with each code it generates.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs SameDeviceSignInCodes::insert tests="tests::only_the_hash_is_kept tests::minting_drops_the_expired_codes tests::minting_forgets_the_expired_sessions"}}

#### `take`

Redeeming a code.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs SameDeviceSignInCodes::take tests="tests::a_code_is_taken_once tests::an_unknown_code_is_not_taken tests::a_code_expires_after_its_ttl"}}

#### `session_stored`

The [sign-in](<../Capabilities/OAuth/Same Device Sign In Explanation.md>) calls this once the session it started is stored.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs SameDeviceSignInCodes::session_stored tests="tests::a_code_withdrawn_while_signing_in_signs_nobody_in"}}

#### `session_not_stored`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs SameDeviceSignInCodes::session_not_stored tests="tests::a_session_not_stored_spends_only_a_redeemed_code"}}

#### `withdraw`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs SameDeviceSignInCodes::withdraw tests="tests::a_withdrawn_code_is_not_taken"}}

#### `signed_in_sid`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs SameDeviceSignInCodes::signed_in_sid tests="tests::a_signed_in_session_is_found_by_its_own_code_until_forgotten"}}

#### `forget_session`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs SameDeviceSignInCodes::forget_session}}

### `CodeSignIn`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs CodeSignIn}}

### `SameDeviceSignInCode`

**A minted code, as the base holds it.** The host keeps it with the launch view it opened the code in, and across the server's runs. Its `Debug` leaves the code out.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs SameDeviceSignInCode}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs SameDeviceSignInCode::new}}

#### `as_str`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs SameDeviceSignInCode::as_str}}

#### `withdraw`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs SameDeviceSignInCode::withdraw}}

#### `signed_in_sid`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs SameDeviceSignInCode::signed_in_sid}}

#### `forget_session`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs SameDeviceSignInCode::forget_session}}

### `SAME_DEVICE_SIGN_IN_CODE_TTL`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs SAME_DEVICE_SIGN_IN_CODE_TTL}}

## `domain::sign_in_redirect`

The tests judge against one [allow-list](<Test Fixtures Explanation.md#same-device-sign-in-codes>): a server, a hosted launcher and Authorization app, and the host's own two pages.

### `SignInDestinations`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs SignInDestinations}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs SignInDestinations::new}}

#### `allow`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs SignInDestinations::allow tests="tests::a_path_on_this_server_is_allowed_as_a_path tests::a_path_naming_another_host_is_refused tests::a_launcher_url_is_allowed tests::an_authorization_app_url_is_allowed tests::a_url_under_the_server_s_own_launcher_or_authorization_app_is_allowed tests::a_url_outside_the_server_s_own_launcher_and_authorization_app_is_refused tests::any_other_url_is_refused tests::a_base_at_an_origin_root_allows_that_origin_only"}}

#### `allow_on_this_server`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs SignInDestinations::allow_on_this_server tests="tests::only_a_path_on_this_server_is_allowed_on_this_server"}}

#### `path_on_this_server`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs SignInDestinations::path_on_this_server}}

### `SignInRedirect`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs SignInRedirect}}

#### `location`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs SignInRedirect::location}}

### `is_under`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs is_under}}
