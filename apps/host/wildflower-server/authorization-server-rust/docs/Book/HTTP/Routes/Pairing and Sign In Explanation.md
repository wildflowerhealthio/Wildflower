# Pairing and Sign-In

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/browser_pairing.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/sign_in.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/sign_out.rs}}

A browser needs a [browser session](<../../Domain/Browser Session Explanation.md>) before it can ask for anything, and it holds one as its `__Host-browser_session` cookie. **There are two ways to get one, and one way to give it up.** A browser that isn't the Owner's asks to be paired: it shows a code, and the Owner approves it from somewhere they are already signed in. The Owner's own browser, on the device the server runs on, is signed in by the base app with a one-time code. Either kind of browser signs out from the **Sign out** button on the server's pages.

Wildflower has no accounts and no passwords. RFC 6749 leaves how a person signs in to an authorization server to the server (§3.1): here, holding the device the server runs on is what makes someone the Owner, and the Owner's approval is what lets any other browser in.

## Pairing a browser

The [pairing page](<Authorization Pages Explanation.md#pairing_page_location>), `GET /oauth/pair`, makes two calls on its own origin: start a pairing, then poll it until the Owner decides. Pairing is no OAuth flow, so the bodies are JSON, not form-encoded. A JSON body needs a CORS preflight from any other origin, and the server's CORS policy never allows credentials, so **only the server's own pages can have a poll's cookie set**. Every answer is uncached: a start carries the pairing code, and an approved poll the session's cookie.

## `handle_browser_pairing_start`

`POST /oauth/pair/start`: park a pairing for this browser, and raise it for the Owner. The body names where the browser goes once paired, in practice the `/oauth/authorize` request it was sent away from:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/browser_pairing.rs BrowserPairingStartBody}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/browser_pairing.rs handle_browser_pairing_start}}

The browser is named after its `User-Agent` ([`device_name_from_user_agent`](<Device Authorization Explanation.md#device_name_from_user_agent>)), a name the page may change while it polls. The start goes through [`BrowserPairing::start`](<../../Capabilities/OAuth/Browser Pairing Explanation.md#start>), which parks the pairing and republishes the newest pending consent, so the host notifies the Owner.

The page gets the secret it polls with, the code it shows, the name, where to go once paired, and the timing:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/browser_pairing.rs StartedBrowserPairingBody}}

**The pairing code is the page's secret; the user code is for the Owner.** The Owner confirms the user code on the device page. Only the page that started the pairing holds the pairing code, so only it can collect the session.

| Refusal                                | Response                                         |
| -------------------------------------- | ------------------------------------------------ |
| `next` is no path on this server       | `400` `{"error":"BrowserPairingNextNotAllowed"}` |
| the browser-session client is disabled | `403` `{"error":"BrowserSessionClientDisabled"}` |
| no unused user code could be generated | a logged `500`                                   |
| a store failure                        | a logged `500`                                   |

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/browser_pairing.rs BrowserPairingRefused}}

Exercised end to end by [`a_browser_pairs_and_holds_a_day_long_session_with_the_approved_scopes`](<../../Integration Tests/Browser Pairing Explanation.md#a_browser_pairs_and_holds_a_day_long_session_with_the_approved_scopes>) and [`a_foreign_next_or_an_unknown_code_starts_and_finds_nothing`](<../../Integration Tests/Browser Pairing Explanation.md#a_foreign_next_or_an_unknown_code_starts_and_finds_nothing>).

## `handle_browser_pairing_poll`

`POST /oauth/pair/poll`: where the pairing stands. The page sends its pairing code and the name it now gives its browser; a blank name keeps the one it has.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/browser_pairing.rs BrowserPairingPollBody}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/browser_pairing.rs handle_browser_pairing_poll}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/browser_pairing.rs BrowserPairingStatusBody}}

**The poll that finds the pairing approved hands the browser its session.** [`BrowserPairing::poll`](<../../Capabilities/OAuth/Browser Pairing Explanation.md#poll>) claims the request, stores the approved browser session and mints its token, and the answer sets that token as the cookie, living for `APPROVED_SESSION_TTL` (a day). The page then goes on to its `next`. `slow_down` means the page polled sooner than its interval; `pending`, `denied` and `expired` set nothing.

An unknown pairing code is a `404`:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/browser_pairing.rs BrowserPairingNotFound}}

A store failure, a session that couldn't be stored, and a token that couldn't be minted are each a logged `500`.

Exercised end to end by [`a_browser_pairs_and_holds_a_day_long_session_with_the_approved_scopes`](<../../Integration Tests/Browser Pairing Explanation.md#a_browser_pairs_and_holds_a_day_long_session_with_the_approved_scopes>), [`a_declined_pairing_sets_no_cookie`](<../../Integration Tests/Browser Pairing Explanation.md#a_declined_pairing_sets_no_cookie>) and [`a_foreign_next_or_an_unknown_code_starts_and_finds_nothing`](<../../Integration Tests/Browser Pairing Explanation.md#a_foreign_next_or_an_unknown_code_starts_and_finds_nothing>).

## `handle_sign_in`

`GET /oauth/sign-in?code=…&next=…`: the Owner's same-device sign-in. The base app mints a one-time code in-process and opens this URL in a browser it can't script. **Redeeming the code signs that browser in as the Owner.** A browser page, not API surface, so it is mounted with the pages and kept out of the spec:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/sign_in.rs router}}

A missing parameter reads as empty, which no code and no allowed `next` is, so it is refused like any other bad value:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/sign_in.rs SignInParams}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/sign_in.rs handle_sign_in}}

On success, [`SameDeviceSignIn::sign_in`](<../../Capabilities/OAuth/Same Device Sign In Explanation.md#sign_in>) answers an Owner session's token and the redirect, and the browser gets the token as its cookie, living for `OWNER_SESSION_TTL` (eight hours), with a `303` to `next`. A `next` that isn't allowed, a disabled browser-session client, or a code that is unknown, spent or expired gets the server's error page, a `400` with no cookie and no redirect:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/sign_in.rs refusal_page}}

**The request's own URL carries the code**, so every answer is uncached and sends no `Referer` on (`Referrer-Policy: no-referrer`). A store failure, an Owner session that couldn't be stored, and a token that couldn't be minted are each a logged `500`.

Exercised end to end by [`a_code_signs_in_once`](<../../Integration Tests/Same Device Sign In Explanation.md#a_code_signs_in_once>), [`an_unknown_code_signs_nobody_in`](<../../Integration Tests/Same Device Sign In Explanation.md#an_unknown_code_signs_nobody_in>), [`the_cookie_holds_an_eight_hour_owner_token`](<../../Integration Tests/Same Device Sign In Explanation.md#the_cookie_holds_an_eight_hour_owner_token>), [`the_browser_goes_on_to_an_allowed_next`](<../../Integration Tests/Same Device Sign In Explanation.md#the_browser_goes_on_to_an_allowed_next>), [`a_next_anywhere_else_is_refused_and_leaves_the_code_redeemable`](<../../Integration Tests/Same Device Sign In Explanation.md#a_next_anywhere_else_is_refused_and_leaves_the_code_redeemable>) and [`a_disabled_browser_session_client_signs_nobody_in_until_re_enabled`](<../../Integration Tests/Same Device Sign In Explanation.md#a_disabled_browser_session_client_signs_nobody_in_until_re_enabled>).

## `handle_sign_out`

`POST /oauth/sign-out`: a browser ending its own browser session, from the **Sign out** form on the server's pages. **The cookie alone authenticates it**; no bearer is involved. A browser page's form, not API surface, so it too is mounted with the pages:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/sign_out.rs router}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/sign_out.rs handle_sign_out}}

When the cookie holds a standing session, [`BrowserSessionEnder::end`](<../../Capabilities/Session/Browser Session Ender Explanation.md#end>) revokes it, which ends everything minted under it. Either way the answer clears the cookie and sends the browser `303` to the hosted launcher's root; the `303` turns the form's `POST` into a `GET`. **A browser always leaves signed out**: one with no cookie, or whose session already ended, has nothing to revoke and gets the same answer. Only a store that can't be read or written makes it a `500`, which leaves the cookie as it was.

Nothing here checks where the form came from. The host's cookie-to-bearer layer refuses a write carrying the cookie from any origin but the server's own, so another page can't sign a browser out.

Exercised end to end by [`signing_out_revokes_the_cookie_s_session_and_clears_it`](<../../Integration Tests/Browser Sessions Explanation.md#signing_out_revokes_the_cookie_s_session_and_clears_it>) and [`signing_out_without_a_standing_session_still_clears_the_cookie`](<../../Integration Tests/Browser Sessions Explanation.md#signing_out_without_a_standing_session_still_clears_the_cookie>).
