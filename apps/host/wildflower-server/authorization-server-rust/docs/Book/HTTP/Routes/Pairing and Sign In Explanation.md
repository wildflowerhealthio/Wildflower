# Pairing and Sign-In

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/browser_pairing.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/sign_in.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/sign_out.rs}}

A browser needs a [browser session](<../../Domain/Browser Session Explanation.md>) before it can ask for anything, and it holds one as its [browser session cookie](<../Browser Session Cookie Explanation.md>). **There are two ways to get one, and one way to give it up.** A browser that isn't the Owner's asks to be paired: it shows a code, and the Owner approves it from somewhere they are already signed in. The Owner's own browser, on the device the server runs on, is signed in by the base app with a one-time [same-device sign-in code](<../../Domain/Same Device Sign In Codes Explanation.md>). Either kind of browser signs out from the **Sign out** button on the server's pages.

Wildflower has no accounts and no passwords. RFC 6749 leaves how a person signs in to an authorization server to the server (§3.1): here, holding the device the server runs on is what makes someone the Owner, and the Owner's approval is what lets any other browser in. The [Browser Pairing](<../../Integration Tests/Browser Pairing Explanation.md>), [Same-Device Sign-In](<../../Integration Tests/Same Device Sign In Explanation.md>) and [Browser Sessions](<../../Integration Tests/Browser Sessions Explanation.md>) integration tests hold these routes end to end.

## `http::routes::oauth::browser_pairing`

The [pairing page](<Authorization Pages Explanation.md#item-pairing_page_location>) makes two calls on its own origin: start a [pairing request](<../../Domain/Authorization Request/Polled Requests Explanation.md>), then poll it until the Owner decides. Pairing is no OAuth flow, so the bodies are JSON, not form-encoded. A JSON body needs a CORS preflight from any other origin, and the server's CORS policy never allows credentials, so **only the server's own pages can have a poll's cookie set**.

### `BrowserPairingStartBody`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/browser_pairing.rs BrowserPairingStartBody}}

### `handle_browser_pairing_start`

The browser is named by [`device_name_from_user_agent`](<Device Authorization Explanation.md#item-device_name_from_user_agent>), a name the page may change while it polls. The start goes through the [browser pairing](<../../Capabilities/OAuth/Browser Pairing Explanation.md>) capability, which parks the pairing and republishes the [Owner prompt](<../../Domain/Owner Prompt Explanation.md>), so the host notifies the Owner.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/browser_pairing.rs handle_browser_pairing_start}}

### `StartedBrowserPairingBody`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/browser_pairing.rs StartedBrowserPairingBody}}

#### `from`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/browser_pairing.rs StartedBrowserPairingBody::from}}

### `BrowserPairingRefused`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/browser_pairing.rs BrowserPairingRefused}}

### `BrowserPairingPollBody`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/browser_pairing.rs BrowserPairingPollBody}}

### `handle_browser_pairing_poll`

**The poll that finds the pairing approved hands the browser its session.** The capability claims the request, stores the approved browser session and mints its token, and the answer sets that token as the cookie through [`browser_session_set_cookie`](<../Browser Session Cookie Explanation.md#item-browser_session_set_cookie>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/browser_pairing.rs handle_browser_pairing_poll}}

### `BrowserPairingStatusBody`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/browser_pairing.rs BrowserPairingStatusBody}}

### `BrowserPairingNotFound`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/browser_pairing.rs BrowserPairingNotFound}}

## `http::routes::oauth::sign_in`

The base app mints a one-time code in-process and opens `/oauth/sign-in` in a browser it can't script. **Redeeming the code signs that browser in as the Owner.** It is a browser page, not API surface, so it is mounted with the pages and kept out of the spec.

### `router`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/sign_in.rs router}}

### `SignInParams`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/sign_in.rs SignInParams}}

### `handle_sign_in`

The code goes to the [same-device sign-in](<../../Capabilities/OAuth/Same Device Sign In Explanation.md>) capability, which answers an Owner session's token and the redirect.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/sign_in.rs handle_sign_in}}

### `refusal_page`

The page is [`sign_in_error_html`](<../Errors and Wire Shapes Explanation.md#item-sign_in_error_html>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/sign_in.rs refusal_page}}

## `http::routes::oauth::sign_out`

A browser ends its own browser session from the **Sign out** form on the server's pages. **The cookie alone authenticates it**; no bearer is involved. **A browser always leaves signed out**: one with no cookie, or whose session already ended, has nothing to revoke and gets the same answer.

Nothing here checks where the form came from. The host's cookie-to-bearer layer refuses a write carrying the cookie from any origin but the server's own, so another page can't sign a browser out.

### `router`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/sign_out.rs router}}

### `handle_sign_out`

The [browser session ender](<../../Capabilities/Session/Browser Session Ender Explanation.md>) revokes the session, which ends everything minted under it, and the answer clears the cookie with [`browser_session_clearing_set_cookie`](<../Browser Session Cookie Explanation.md#item-browser_session_clearing_set_cookie>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/sign_out.rs handle_sign_out}}
