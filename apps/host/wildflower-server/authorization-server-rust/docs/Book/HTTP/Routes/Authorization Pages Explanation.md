# Authorization Pages

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/pages.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/wait_page.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_status.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_shortfall.rs}}

While a request waits, **the browser waits on a page this server serves, on its own origin**, so the address bar names the server being approved. `/oauth/authorize` sends the browser to one of three pages beside it: the wait page while the Owner decides elsewhere, the consent card when this browser decides itself, the limited page when its session holds less than the app asks for. Two more pages are reached another way: the device page, where the Owner confirms a device's code, and the pairing page, where a browser without a session asks for one.

The pages are static. Each is the same bytes for every request, and reads the request id or code from its own URL, so nothing a caller sends can reach the markup. What changes is answered by JSON routes beside them: the status poll the wait page drives, and the three calls the limited page makes. All of it is uncached, and all of it is locked down by the same security headers.

## `content_security_policy`

**A page loads only from this origin, talks only to this origin, and can't be framed.** The one thing that differs between pages is where their forms may go: the wait page has no form (`NO_FORM_TARGETS`, `'none'`), and the React pages' **Sign out** form posts here and is redirected on to the launcher. The redirect back to the app is a top-level navigation, not a fetch, so `connect-src` doesn't constrain it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/pages.rs content_security_policy}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/pages.rs NO_FORM_TARGETS}}

No unit test of its own; [the React pages' tests](#authorization_pagesrouter) check the whole header.

## `page_security_headers`

The four headers every file of every page carries: its type, its policy, `Referrer-Policy: same-origin` and `X-Content-Type-Options: nosniff`. The referrer policy is `same-origin`, not `no-referrer`: under `no-referrer` a browser sends a form `POST` with `Origin: null`, which the host's cookie-to-bearer layer refuses, and **Sign out** would fail.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/pages.rs page_security_headers}}

Checked on every page by [`assert_locked_down`](#test-fixtures).

## `request_page_location`

The `Location` of a page for one pending request, `authorize/{id}/{page}`. It is relative, so the browser resolves it against the `…/oauth/authorize` it just requested. The id is encoded to stay one path segment, whatever it holds.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/pages.rs request_page_location}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/pages.rs tests::a_request_page_resolves_beside_the_authorize_endpoint}}

Resolved against an authorize URL with a query, the wait and consent locations land at `/oauth/authorize/req-1/wait` and `…/consent`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/pages.rs tests::a_request_page_location_keeps_the_id_one_segment}}

A slash, a space and a question mark in the id are percent-encoded.

## The wait page

The wait page is where a browser waits **while the Owner decides somewhere else**: in the host's popup, in a signed-in launcher, or on a consent card. Its script polls [the status](#handle_authorization_status_request) until the request is decided, then follows the redirect the poll hands back, built from the app's registered (or just-approved) `redirect_uri`. That redirect is the only address off this origin the page ever leaves for. While the request is pending, the page also checks whether this browser has since signed in as the Owner (it can read the request's consent) and, if so, switches to the consent card beside it.

Its three files are embedded as they are, with nothing interpolated. The script reads the request id from its own path. The script has no unit tests; the integration tests pin how its files are served.

## `wait_page::router`

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/wait_page.rs router}}

The page names its files `../wait.js` and `../wait.css`, which resolve to the two siblings under any mount. Every file goes out through one helper: the page's headers, under a policy with no form targets, and uncached, like the poll it drives, so an update to the server never leaves a stale script polling a changed endpoint.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/wait_page.rs page_file}}

Exercised end to end by [`the_wait_page_is_static_and_locked_down`](<../../Integration Tests/Wait Page Explanation.md#the_wait_page_is_static_and_locked_down>) and [`the_wait_page_assets_are_served_beside_it`](<../../Integration Tests/Wait Page Explanation.md#the_wait_page_assets_are_served_beside_it>).

## `wait_page_location`

Where `/oauth/authorize` parks a browser whose session can't approve the request.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/wait_page.rs wait_page_location}}

Exercised end to end by [`a_parked_request_waits_beside_the_authorize_endpoint`](<../../Integration Tests/Wait Page Explanation.md#a_parked_request_waits_beside_the_authorize_endpoint>).

## The React pages

The consent card, the limited page, the device page and the pairing page are the build of `authorization-server-web`, embedded in the binary when it is compiled:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs AUTHORIZATION_PAGES}}

| Route                               | Page           | What it does                                                                                           |
| ----------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /oauth/authorize/{id}/consent` | `consent.html` | The consent card: a browser that can decide the request decides it in place                            |
| `GET /oauth/authorize/{id}/limited` | `limited.html` | The limited page: says what the session lacks, then goes on or cancels                                 |
| `GET /oauth/device`                 | `device.html`  | The device page: RFC 8628's `verification_uri`, and with `?user_code=` its `verification_uri_complete` |
| `GET /oauth/pair?next=…`            | `pair.html`    | The pairing page: a browser without a session starts a pairing, shows its code and waits for the Owner |
| `GET /oauth/assets/{*file}`         | `assets/…`     | The pages' scripts, stylesheets and fonts                                                              |

The consent card and the device page call `/authorization/*` and FHIR on the browser session's bearer, which the host's cookie-to-bearer layer presents for them. The pairing page calls `/oauth/pair/*`, which needs no session. The limited page calls `/oauth/authorize/{id}/*`, on the browser session's cookie.

### Test fixtures

The unit tests serve a fake build laid out as Vite lays it out: the four pages, and hashed files under `assets/`, including a `.woff` and an `.svg` the routes must refuse.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs tests::PAGES}}

`launcher_base` is a launcher on another origin, so the policy's form targets name it:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs tests::launcher_base}}

`get` sends one request to the routes over the fake build; `body` and `header_of` read the answer:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs tests::get}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs tests::body}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs tests::header_of}}

`assert_locked_down` checks the three headers every page and asset carries, the policy naming this origin and the launcher's as form targets:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs tests::assert_locked_down}}

## `authorization_pages::router`

The React pages' routes. Their forms may submit to this origin and to the launcher's, because **Sign out** posts to [`/oauth/sign-out`](<Pairing and Sign In Explanation.md#handle_sign_out>), which redirects to the launcher.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs router}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs sign_out_form_targets}}

`router_for` builds the policy once and serves each page and the assets from the given build, which is how the unit tests serve their fake one:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs router_for}}

**A page is the same uncached bytes whatever its URL holds.** A page missing from the build is a `404`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs page}}

**An asset is cached for a year without revalidating**, since Vite's file names carry a hash of their contents and never change under a name. Only a script, a stylesheet or a font is served, the only files a page may load under its policy; anything else is a `404`, even when the build holds it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs asset}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs asset_content_type}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs tests::the_consent_card_is_the_same_uncached_page_for_every_request}}

A plain id and an id spelling `<script>` get the same `200`, locked down, `no-store`, with the page's own bytes.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs tests::the_limited_page_is_the_same_uncached_page_for_every_request}}

The limited page, likewise.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs tests::the_device_page_is_the_same_uncached_page_with_or_without_a_code}}

The device page, with no code, a code, or markup as the code.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs tests::the_pairing_page_is_the_same_uncached_page_whatever_its_next}}

The pairing page, whatever its `next`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs tests::hashed_scripts_stylesheets_and_fonts_are_immutable_with_their_types}}

Scripts, a stylesheet and a `.woff2` font are served with their types, locked down, and cached as `immutable`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs tests::anything_but_a_built_script_stylesheet_or_font_is_not_found}}

A missing asset, a `.woff`, an `.svg`, a path climbing out of `assets/`, a page by its file name, and a path under the device page are all `404`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs tests::the_embedded_build_has_the_consent_limited_device_and_pairing_pages}}

Whatever build was compiled into the binary has all four pages.

Exercised end to end by [`the_consent_card_is_locked_down_and_uncached`](<../../Integration Tests/Consent Card Explanation.md#the_consent_card_is_locked_down_and_uncached>) and [`verification_uri_complete_serves_the_device_page_on_the_server_origin`](<../../Integration Tests/Device Page Explanation.md#verification_uri_complete_serves_the_device_page_on_the_server_origin>).

## `consent_page_location`

Where `/oauth/authorize` sends a browser that can decide the request itself: its session can decide consents and holds the request's approval scopes.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs consent_page_location}}

No unit test of its own; [`request_page_location`](#request_page_location)'s tests resolve the `consent` page. Exercised end to end by [`a_browser_signed_in_as_the_owner_goes_to_the_consent_card`](<../../Integration Tests/Consent Card Explanation.md#a_browser_signed_in_as_the_owner_goes_to_the_consent_card>).

## `limited_page_location`

Where `/oauth/authorize` sends a browser whose session holds less than the request asks for.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs limited_page_location}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs tests::the_limited_location_resolves_to_the_limited_page}}

An id with a space, a slash and a question mark resolves to one encoded segment before `/limited`.

## `pairing_page_location`

Where `/oauth/authorize` sends a browser without a session: the pairing page, with `next` holding the path and query of the authorize request it made, so the paired browser comes back to that very request.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs pairing_page_location}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs tests::the_pairing_location_resolves_to_the_pairing_page_carrying_next}}

The location resolves to `/oauth/pair`, and its one `next` decodes back to the authorize path and query, encoded characters, `#` and `+` included.

## `device_page_url`

RFC 8628's `verification_uri` for the server at `server_origin`: the device page, an absolute URL, since a device shows it to a person who types it elsewhere.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs device_page_url}}

## `device_page_url_with_code`

RFC 8628's `verification_uri_complete`: the device page with the code in its query. The page fills its code box from it, and still asks the Owner to confirm.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs device_page_url_with_code}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs tests::the_device_page_urls_are_on_the_server_origin_with_the_code_encoded}}

Both URLs keep the origin's port, and a code holding `&` and a space is form-encoded.

## `AuthorizationStatus`

What the wait page polls for: where the request stands, and once it is decided, where to send the browser.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_status.rs AuthorizationStatus}}

**Every answer is uncached.** An `approved` one carries the app's redirect with a redeemable code, which no cache may keep, and the other states are rendered the same way so the poll's caching never differs by state.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_status.rs AuthorizationStatus::into_response}}

## `handle_authorization_status_request`

`GET /oauth/authorize/{id}`, the wait page's poll. **A leaked request id collects nothing.** The poll answers the browser session the request was made in, and a session whose grant covers `wildflower/AuthorizationRequest.r` and `.u` (one that could decide the request on the consent card anyway). Any other caller, with another session or none, gets the same `404` as an unknown id. The reader enforces it ([`status`](<../../Capabilities/OAuth/Authorization Status Reader Explanation.md#status>)); the handler passes the browser session the cookie carries.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_status.rs handle_authorization_status_request}}

| The request                    | The answer                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| pending                        | `{"status":"pending"}`                                                                                       |
| pending past its expiry        | `{"status":"error","message":"Authorization request expired"}`                                               |
| denied                         | `{"status":"denied","redirect":…}`: the app's redirect with `error=access_denied`, a description and `state` |
| approved                       | `{"status":"approved","redirect":…}`: the app's redirect with `code` and `state`                             |
| not readable by this caller    | `404` `AuthorizationRequestNotFound`                                                                         |
| approved, but its code is gone | `500` `server_error`, an invariant the store broke                                                           |

The poll can't tell an Owner's decline from a browser session revoked under the request, so **every denial reads as declined**. Only code requests are answered here; a device and a pairing have polls of their own, so a `denied` answer always carries its `redirect`.

Exercised end to end by [`a_leaked_request_id_collects_nothing`](<../../Integration Tests/Session Required Explanation.md#a_leaked_request_id_collects_nothing>), [`the_wait_page_reads_the_status_after_the_owner_signs_in_in_the_same_browser`](<../../Integration Tests/Session Required Explanation.md#the_wait_page_reads_the_status_after_the_owner_signs_in_in_the_same_browser>), [`approving_on_the_owner_s_bearer_sends_the_code_to_the_client_and_settles_the_wait_page`](<../../Integration Tests/Consent Card Explanation.md#approving_on_the_owner_s_bearer_sends_the_code_to_the_client_and_settles_the_wait_page>), [`denying_sends_access_denied_to_the_client_and_settles_the_wait_page`](<../../Integration Tests/Consent Card Explanation.md#denying_sends_access_denied_to_the_client_and_settles_the_wait_page>) and [`pending_authorization_status_is_cache_suppressed`](<../../Integration Tests/Cache Suppression Explanation.md#pending_authorization_status_is_cache_suppressed>).

## The limited page's calls

A browser whose session holds less than an app asks for is told so on the limited page before anyone else is bothered. The page makes three calls on its own origin: read what the session lacks, go on, or cancel. **Each answers only the browser session the request was made in**, read from the cookie as the status poll reads it. Any other browser, with another session or none, gets the same `404` as an unknown id:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_shortfall.rs requesting_browser_session}}

The two posts carry no body, so another page could send them as a simple request. What refuses one is the host's cookie-to-bearer layer, which answers `403` to a write carrying the cookie from any origin but the server's. Every answer is uncached, since a Continue may carry the app's redirect with a code.

## `handle_session_shortfall_read`

`GET /oauth/authorize/{id}/session-shortfall`: the app's name (or its `client_id`, for an app with no registration yet), and the requested scopes this session lacks, in the request's order.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_shortfall.rs SessionShortfallBody}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_shortfall.rs handle_session_shortfall_read}}

It goes through [`SessionShortfall::read`](<../../Capabilities/OAuth/Session Shortfall Explanation.md#read>), which finds the request only while it is pending, unexpired, unacknowledged and made in this session.

Exercised end to end by [`the_fast_path_stops_at_the_limited_page_then_issues_the_narrowed_code`](<../../Integration Tests/Session Shortfall Explanation.md#the_fast_path_stops_at_the_limited_page_then_issues_the_narrowed_code>) and [`another_browser_can_neither_read_nor_continue_nor_cancel`](<../../Integration Tests/Session Shortfall Explanation.md#another_browser_can_neither_read_nor_continue_nor_cancel>).

## `handle_session_shortfall_continue`

`POST /oauth/authorize/{id}/continue`: go on although the session falls short. The request takes the branch `/oauth/authorize` would have taken had the session held everything: a code under a standing grant that covers it, else the consent card or the wait page, as recorded when the request started. The request's five minutes start again, and this session's later requests for the same app skip the limited page. **Going on spends nothing from the start limit**: the request spent when it parked.

The answer is JSON naming where the page sends the browser next:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_shortfall.rs SessionShortfallNextBody}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_shortfall.rs handle_session_shortfall_continue}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_shortfall.rs next_location}}

It goes through [`continue_past_session_shortfall`](<../../Capabilities/OAuth/Code Authorization Starter Explanation.md#continue_past_session_shortfall>), and [`next_step_location`](<Authorize Explanation.md#next_step_location>) builds the location, under `/oauth/`, since the page follows it from elsewhere. The failures:

- A request no longer waiting on this page is the `404`. So is one cancelled between this Continue's acknowledgement and its fast-path approval, which the starter reports as no longer pending.
- An app disabled while the browser sat on the page ends the request: it is denied, and the location is the app's redirect with `access_denied`, as Cancel's is.
- Anything else renders as `/oauth/authorize` would render it ([`AuthorizeError`](<Authorize Explanation.md#authorizeerror>)): a `503` without a signing key, a logged `500` for a store failure.

Exercised end to end by [`the_fast_path_stops_at_the_limited_page_then_issues_the_narrowed_code`](<../../Integration Tests/Session Shortfall Explanation.md#the_fast_path_stops_at_the_limited_page_then_issues_the_narrowed_code>), [`without_a_standing_grant_continue_raises_the_request_for_the_owner`](<../../Integration Tests/Session Shortfall Explanation.md#without_a_standing_grant_continue_raises_the_request_for_the_owner>), [`continue_for_an_app_disabled_since_denies_the_request`](<../../Integration Tests/Session Shortfall Explanation.md#continue_for_an_app_disabled_since_denies_the_request>), [`a_session_that_went_on_for_an_app_skips_the_limited_page_for_it`](<../../Integration Tests/Session Shortfall Explanation.md#a_session_that_went_on_for_an_app_skips_the_limited_page_for_it>) and [`a_continue_whose_start_was_counted_does_not_ask_the_gate_again`](<../../Integration Tests/Authorization Start Limit Explanation.md#a_continue_whose_start_was_counted_does_not_ask_the_gate_again>).

## `handle_session_shortfall_cancel`

`POST /oauth/authorize/{id}/cancel`: deny the request and send the browser back to the app with `error=access_denied`. Cancel isn't remembered: the session's next request for the app stops at the limited page again.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_shortfall.rs handle_session_shortfall_cancel}}

It goes through [`SessionShortfall::cancel`](<../../Capabilities/OAuth/Session Shortfall Explanation.md#cancel>), which records the denial with [`deny_on_limited_page`](<../../Domain/Authorization Request Explanation.md#deny_on_limited_page>).

Exercised end to end by [`cancel_answers_the_app_access_denied`](<../../Integration Tests/Session Shortfall Explanation.md#cancel_answers_the_app_access_denied>) and [`an_expired_request_on_the_limited_page_goes_no_further`](<../../Integration Tests/Session Shortfall Explanation.md#an_expired_request_on_the_limited_page_goes_no_further>).
