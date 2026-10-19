# Authorize

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorize.rs}}

`GET /oauth/authorize` is the front door of the authorization-code flow (RFC 6749 §3.1). Nothing in the server calls it. An app finds it in the FHIR server's `.well-known/smart-configuration` and sends **the person's browser** here, with PKCE and a `state`. Everything the endpoint answers is for that browser: a redirect onward, or a page saying why it can't.

**No browser session, no authorization.** A browser that carries no live browser session is sent to the pairing page first, and nothing is parked, consumed or raised. A browser with one has its request handed to the [code authorization starter](<../../Capabilities/OAuth/Code Authorization Starter Explanation.md#start>), which validates it, parks it as an [authorization request](<../../Domain/Authorization Request Explanation.md#the-code-request>) made in that session, and says where the browser goes next. The handler turns that answer into a `302`.

Where the browser can end up:

| Next stop                                          | When                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| the pairing page, `/oauth/pair?next=…`             | the browser carries no live browser session                                                            |
| the app's `redirect_uri`, with `code` and `state`  | a standing grant already covers every requested scope (the fast path)                                  |
| the limited page, `/oauth/authorize/{id}/limited`  | the browser's session holds less than the request asks for, and it hasn't gone on for this app before  |
| the consent card, `/oauth/authorize/{id}/consent`  | the browser's session can decide consents and holds the request's approval scopes: it decides in place |
| the wait page, `/oauth/authorize/{id}/wait`        | anything else: the request is raised for the Owner, and the page polls for the decision                |
| the app's `redirect_uri`, with `error` and `state` | a request that fails once its redirect is trusted                                                      |
| a local `400` page                                 | a request that fails while its redirect isn't trusted: redirecting there would be an open redirect     |

## `AuthorizeParams`

The query, as RFC 6749 §4.1.1 and RFC 7636 define it, and stricter: `state` is required, and so is a PKCE challenge. A query missing any of the seven required parameters fails to deserialize, and axum answers its own `400` before the handler runs. The starter checks the values (`response_type` is `code`, the method is `S256`, and so on).

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorize.rs AuthorizeParams}}

`launch` and `aud` are SMART App Launch's. `launch` names a [launch context](<../../Domain/Launch Context Explanation.md>) the server minted for this client; the request consumes it, so it works once. `aud`, when sent, must be this server's origin. Both are checked by the starter, which refuses a bad one as `invalid_request`.

## `handle_authorize_request`

The handler itself. It reads the browser session from the request's cookie ([`carried_browser_session`](<../Browser Session Cookie Explanation.md#carried_browser_session>)) before anything else. A session that can't be checked, because a store can't be read, is a logged `500`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorize.rs handle_authorize_request}}

- **Without a session**, the browser goes to [the pairing page](<Authorization Pages Explanation.md#pairing_page_location>), carrying this request's own path and query as `next`. Once the Owner approves the pairing, the page sends the browser back here, now with a session.
- **With a session**, the starter gets the query, the session's grant, its `sid`, and whether it [can decide consents](<../Browser Session Cookie Explanation.md#can_decide_consents>). It also gets two fresh values it may not use: a request id, and the code the fast path issues. The code is issued under **this** browser's session, whoever approves it.
- **The start limit is asked only when it must be.** The limit's layer [defers](<../Middleware Explanation.md#deferredstartlimit>) a request from a browser that can decide consents, and one carrying no session. `may_raise_for_owner` asks the deferred limit, and the starter calls it only before it raises the request for the Owner or parks it for the limited page. With nothing deferred, the layer has already asked, and `may_raise_for_owner` answers yes.

Exercised end to end by [`a_browser_without_a_session_goes_to_pairing`](<../../Integration Tests/Consent Card Explanation.md#a_browser_without_a_session_goes_to_pairing>), [`a_browser_without_a_session_is_sent_to_pairing_even_with_a_standing_grant`](<../../Integration Tests/Session Required Explanation.md#a_browser_without_a_session_is_sent_to_pairing_even_with_a_standing_grant>), [`auth_code_grant_happy_path_end_to_end`](<../../Integration Tests/Grant Flows Explanation.md#auth_code_grant_happy_path_end_to_end>), [`pre_approved_scopes_skip_consent_on_reauthorize`](<../../Integration Tests/Grant Flows Explanation.md#pre_approved_scopes_skip_consent_on_reauthorize>), [`a_browser_signed_in_as_the_owner_goes_to_the_consent_card`](<../../Integration Tests/Consent Card Explanation.md#a_browser_signed_in_as_the_owner_goes_to_the_consent_card>), [`a_browser_session_that_cannot_decide_consents_goes_to_the_wait_page`](<../../Integration Tests/Consent Card Explanation.md#a_browser_session_that_cannot_decide_consents_goes_to_the_wait_page>), [`the_fast_path_stops_at_the_limited_page_then_issues_the_narrowed_code`](<../../Integration Tests/Session Shortfall Explanation.md#the_fast_path_stops_at_the_limited_page_then_issues_the_narrowed_code>) and [`a_browser_without_a_session_is_sent_to_pairing_without_asking_the_gate`](<../../Integration Tests/Authorization Start Limit Explanation.md#a_browser_without_a_session_is_sent_to_pairing_without_asking_the_gate>).

## `next_step_location`

Where the starter's [`AuthorizeNextStep`](<../../Capabilities/OAuth/Code Authorization Starter Explanation.md#authorizenextstep>) sends the browser. A fully pre-approved request goes straight back to the app with its code. A parked one goes to a page for the request: the consent card when the browser can decide it, the wait page when it can't, the limited page when its session falls short.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorize.rs next_step_location}}

The pages' locations are relative to `/oauth/` ([`request_page_location`](<Authorization Pages Explanation.md#request_page_location>)). `page_prefix` is empty for `/oauth/authorize`'s own `Location`, which the browser resolves against the endpoint it just requested. The limited page's [Continue](<Authorization Pages Explanation.md#handle_session_shortfall_continue>) is answered as JSON for a page to follow, so it passes `/oauth/`.

No unit test of its own; every redirect test above passes through it.

## `AuthorizeError`

Every way the endpoint fails, each rendered as one response shape. A fallible step bails with `?`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorize.rs AuthorizeError}}

The starter's [`AuthorizationStartError`](<../../Capabilities/OAuth/Code Authorization Starter Explanation.md#authorizationstarterror>) maps onto it. A redirectable error has its `Location` built here: the app's `redirect_uri` with `error`, `error_description` and `state` (RFC 6749 §4.1.2.1). A request the fast path found no longer pending, and a store failure, are both logged `500`s.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorize.rs AuthorizeError::from}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorize.rs AuthorizeError::into_response}}

| Variant              | Response                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `LocalPage`          | `400` with the server's own HTML error page ([`oauth_error_html`](<../Errors and Wire Shapes Explanation.md#oauth_error_html>)) |
| `Redirect`           | `302` back to the app, carrying the error                                                                                       |
| `ServiceUnavailable` | `503`: no active signing key, so no code could ever be issued, and nothing is parked                                            |
| `StartLimited`       | `429`, as the limit's layer answers ([`start_limited_response`](<../Middleware Explanation.md#start_limited_response>))         |
| `Internal`           | a logged, opaque `500` ([`InternalError`](<../Errors and Wire Shapes Explanation.md#internal_error>))                           |

Exercised end to end by [`authorize_unknown_client_renders_later_failures_locally`](<../../Integration Tests/OAuth Endpoints Explanation.md#authorize_unknown_client_renders_later_failures_locally>), [`authorize_disabled_client_is_still_rejected`](<../../Integration Tests/OAuth Endpoints Explanation.md#authorize_disabled_client_is_still_rejected>), [`authorize_unsupported_response_type_redirects_back`](<../../Integration Tests/OAuth Endpoints Explanation.md#authorize_unsupported_response_type_redirects_back>), [`authorize_refuses_a_bad_smart_launch_or_aud`](<../../Integration Tests/OAuth Endpoints Explanation.md#authorize_refuses_a_bad_smart_launch_or_aud>) and [`a_deciding_browser_s_request_raised_for_the_owner_asks_the_gate`](<../../Integration Tests/Authorization Start Limit Explanation.md#a_deciding_browser_s_request_raised_for_the_owner_asks_the_gate>).

## Response helpers

Every redirect is a `302 Found`, the status RFC 6749's examples use. axum's `Redirect` offers only `303`, `307` and `308`, so the endpoint builds its own:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorize.rs found_redirect}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorize.rs html_bad_request}}
