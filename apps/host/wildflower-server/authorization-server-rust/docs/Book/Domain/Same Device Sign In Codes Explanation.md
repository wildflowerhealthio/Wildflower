# Same-Device Sign-In Codes

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs}}

The Owner signs a browser in by asking the base, the Wildflower app on the device that runs the server. The base mints a **same-device sign-in code** in-process and opens `GET /oauth/sign-in?code=…&next=…` in a browser. Whoever presents the code there first, in time, starts an Owner session in that browser. Only the base can mint a code, and the base runs on the server's own device, so redeeming one stands for "this browser is on the Owner's device". The [same-device sign-in proof](<../Authority/Same Device Sign In Explanation.md>) is that redemption; this page is the codes it redeems from, and where the browser may be sent once it is signed in.

**A code is single-use, short-lived, and never stored in the clear.** Each is 256 random bits, redeemable once, for a minute. The outstanding codes live only in the server's memory and only as SHA-256 hashes: a restart drops them all, and reading the server's memory yields none.

## `SAME_DEVICE_SIGN_IN_CODE_TTL`

How long a code stays redeemable after it is minted. The base opens the sign-in URL as soon as it has the code, so a minute is plenty.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs SAME_DEVICE_SIGN_IN_CODE_TTL}}

Its test is under [`take`](#take).

## `SameDeviceSignInCodes`

The outstanding codes: each one's storage hash, with when it expires. One set is built at setup and shared by the base's minter and the sign-in capability.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs SameDeviceSignInCodes}}

`new` starts with none outstanding.

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs SameDeviceSignInCodes::new}}

## `insert`

**Minting a code**: keep its hash until a minute past `now`. The codes already expired are dropped on the way, so the set only ever holds live ones. The base's minter calls this with each code it generates.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs SameDeviceSignInCodes::insert}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs tests::only_the_hash_is_kept}}

After a code is minted, the set holds its hash and not the code.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs tests::minting_drops_the_expired_codes}}

Minting a second code a full minute after the first drops the first: only the fresh one is left.

## `take`

**Redeeming a code**: remove the presented code's hash and answer whether it was outstanding and unexpired. It is gone afterwards either way, so a code is redeemed at most once, and an expired one is spent by the attempt. The presented code is hashed before the lookup, so the lookup compares hashes, never the code itself.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs SameDeviceSignInCodes::take}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs tests::a_code_is_taken_once}}

The first take succeeds, the second finds nothing.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs tests::an_unknown_code_is_not_taken}}

An unknown code is refused and leaves the outstanding code redeemable.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs tests::a_code_expires_after_its_ttl}}

A second before the minute is up the code redeems; at the minute it doesn't.

Exercised end to end by [`a_code_signs_in_once`](<../Integration Tests/Same Device Sign In Explanation.md#a_code_signs_in_once>) and [`an_unknown_code_signs_nobody_in`](<../Integration Tests/Same Device Sign In Explanation.md#an_unknown_code_signs_nobody_in>).

## Where a sign-in may send the browser

A sign-in URL carries a `next`: where the browser goes once the Owner session has started. **A `next` is held to an allow-list**, so a sign-in link can't be turned into a redirect to anywhere. A `next` is allowed when it is

- a path on this server: it starts with `/` but not `//`, and still names this server's origin once resolved against it;
- a URL under the hosted launcher or the Wildflower Authorization app;
- a URL under the pages the host opens for this server, its own launcher and Authorization app: the page itself, whatever its query, or a URL within it as a folder.

Each is judged by the URL a browser would make of it, parsed as the WHATWG URL standard says, so spellings a browser reads as another host (`/\evil.example`, a tab inside `//`, `user@host`) resolve to that host here too, and are refused. **The redirect is the parsed URL re-serialized, never the raw `next`.**

The sign-in checks `next` before it touches the code, so a refused `next` leaves the code redeemable.

## `SignInDestinations`

The allow-list: this server's origin, which a path must stay on, and the four pages a URL may be under.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs SignInDestinations}}

| Field               | The place it allows                                                          |
| ------------------- | ---------------------------------------------------------------------------- |
| `server_origin`     | Paths on this server.                                                        |
| `launcher`          | URLs under the hosted launcher.                                              |
| `authorization_app` | URLs under the hosted Wildflower Authorization app.                          |
| `launcher_url`      | The page the host opens this server's launches in, and URLs within it.       |
| `authorization_url` | The page the host opens this server's Authorization app at, and URLs within. |

It is built once at setup from the server's configuration.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs SignInDestinations::new}}

## `SignInRedirect`

A `next` the allow-list let through: the `Location` the sign-in answers with. Only the allow-list makes one. A path on this server stays a path, so the browser stays on the server's origin; `location` reads it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs SignInRedirect}}

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs SignInRedirect::location}}

## Test fixtures

The tests judge against a server at `https://ruth.relay.example`, a hosted launcher and Authorization app under paths of `https://site.example`, and the host's own launcher page (with a query) and Authorization page on two more origins.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs tests::destinations}}

`allowed` is the `Location` a `next` would get, or `None`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs tests::allowed}}

## `allow`

**Where a sign-in may go next.** A `next` starting with `/` is judged as a path on this server; anything else must parse as a URL under one of the four pages.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs SignInDestinations::allow}}

A path is resolved against the server's origin and kept only while the origin is unchanged; what's kept is its path and query.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs SignInDestinations::path_on_this_server}}

A URL is under a page when it has the page's origin, carries no credentials, and its path is the page's own path or lies within it as a folder. A base's path ends in `/`, so only the paths within it are.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs is_under}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs tests::a_path_on_this_server_is_allowed_as_a_path}}

A path keeps its query, `/` is allowed, and `/a/../b` comes back normalized as `/b`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs tests::a_path_naming_another_host_is_refused}}

`//host`, a backslash after the slash, and a tab or newline between the slashes all resolve to another host and are refused.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs tests::a_launcher_url_is_allowed}}

The hosted launcher's base, with a query, and a page within it are allowed as given.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs tests::an_authorization_app_url_is_allowed}}

So is the hosted Authorization app's base with a query.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs tests::a_url_under_the_server_s_own_launcher_or_authorization_app_is_allowed}}

The host's launcher page is allowed with any query (a launch adds `iss` and `launch`), without one, and with a path within it; the host's Authorization page likewise.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs tests::a_url_outside_the_server_s_own_launcher_and_authorization_app_is_refused}}

A sibling path that only shares a prefix (`launcherx`, `launcher.html`), the bare origin, `http`, credentials, and the Authorization page without its trailing slash are all refused.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs tests::any_other_url_is_refused}}

Everything else is refused: another origin, the allowed origin outside both bases, a base without its trailing slash, a `..` that climbs out (encoded or not), another scheme or port, credentials or a host hidden behind them, this server as an absolute URL, `javascript:`, a bare host and the empty string.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs tests::a_base_at_an_origin_root_allows_that_origin_only}}

With the launcher and Authorization app each at the root of their own origin, everything on that origin is allowed, and nothing on the parent domain, a sibling subdomain, a lookalike host or `http`.

Exercised end to end by [`the_browser_goes_on_to_an_allowed_next`](<../Integration Tests/Same Device Sign In Explanation.md#the_browser_goes_on_to_an_allowed_next>) and [`a_next_anywhere_else_is_refused_and_leaves_the_code_redeemable`](<../Integration Tests/Same Device Sign In Explanation.md#a_next_anywhere_else_is_refused_and_leaves_the_code_redeemable>).

## `allow_on_this_server`

**A browser pairing may only go on to this server.** An approved browser is sent on to the server's own `/oauth/authorize`, never off it, so a pairing's `next` must be a path on this server: the launcher and Authorization app a sign-in may go on to are refused here.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs SignInDestinations::allow_on_this_server}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs tests::only_a_path_on_this_server_is_allowed_on_this_server}}

A path to `/oauth/authorize` is allowed; the launcher, the Authorization app, this server as an absolute URL, a path naming another host, `javascript:` and the empty string are not.

Exercised end to end by [`a_foreign_next_or_an_unknown_code_starts_and_finds_nothing`](<../Integration Tests/Browser Pairing Explanation.md#a_foreign_next_or_an_unknown_code_starts_and_finds_nothing>).
