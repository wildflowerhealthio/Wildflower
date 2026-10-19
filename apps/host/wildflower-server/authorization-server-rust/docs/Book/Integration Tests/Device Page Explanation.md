# Device Page

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/device_page.rs}}

The device page is where a person types, or follows a link with, a device's user code and approves it. `/oauth/device_authorization` points the device's user at it as `verification_uri_complete`: `/oauth/device` on the server's own origin. The page is the same bytes whatever the code: it reads the code from its own URL. It decides the request through the same `/authorization/devices/{userCode}` API the [Device Code](<Device Code Explanation.md>) tests drive, on the bearer of the browser session that opened it.

In production, turning the page's browser session cookie into that bearer is the host's job (`wildflower-server-rust`), not this crate's. So these tests send the browser session's token as the bearer themselves. The session is an Owner sign-in ([`signed_in_owner_session_token`](<../Integration Tests Explanation.md#signed_in_owner_session_token>)); the [Browser Session](<../Domain/Browser Session Explanation.md>) page explains what it holds.

## Helpers

The codes `/oauth/device_authorization` answers with, and the call that gets them for the test client:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/device_page.rs DeviceAuthorization}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/device_page.rs start_device_flow}}

A call on the device-consent API with an optional bearer, and the device's token poll:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/device_page.rs device_consent_request}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/device_page.rs poll}}

## `verification_uri_complete_serves_the_device_page_on_the_server_origin`

**The link a device hands its user opens the device page, on the server's own origin.** The link's origin is the server's, and following it serves HTML that is never cached and carries a Content Security Policy.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/device_page.rs verification_uri_complete_serves_the_device_page_on_the_server_origin}}

The link is built by {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs device_page_url_with_code}}, and the page served by {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs router_for}}.

## `a_browser_session_approves_the_code_and_the_device_poll_succeeds`

**A signed-in browser session can read and approve a device's request, and the device's next poll gets its token.** The prompt names the user code, the approval answers `approved`, and the poll returns a token for the approved scope.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/device_page.rs a_browser_session_approves_the_code_and_the_device_poll_succeeds}}

Relies on [`approve_device`](<../Domain/Authorization Request Explanation.md#approve_device>) and [`claim`](<../Domain/Authorization Request Explanation.md#claim>).

## `without_a_session_the_request_is_left_pending`

**Without a session, the page can neither read nor decide the request.** Both calls are `401`, and the request is untouched: the device's poll still hears `authorization_pending`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/device_page.rs without_a_session_the_request_is_left_pending}}

## `an_unknown_code_is_not_found_for_the_browser_session`

**A code that names no pending device request is `404 DeviceConsentNotFound`.** The answer echoes the code back, so the page can say which one it couldn't find.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/device_page.rs an_unknown_code_is_not_found_for_the_browser_session}}

The lookup is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/device.rs load_pending_request_by_user_code}}.
