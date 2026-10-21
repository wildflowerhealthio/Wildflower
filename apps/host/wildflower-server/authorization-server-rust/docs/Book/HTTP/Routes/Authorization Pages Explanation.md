# Authorization Pages

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/pages.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/wait_page.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_status.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_shortfall.rs}}

While a request waits, **the browser waits on a page this server serves, on its own origin**, so the address bar names the server being approved. `/oauth/authorize` sends the browser to one of three pages beside it: the wait page while the Owner decides elsewhere, the consent card when this browser decides itself, the limited page when its session holds less than the app asks for. Two more pages are reached another way: the device page, where the Owner confirms a device's code, and the pairing page, where a browser without a session asks for one.

The pages are static. Each is the same bytes for every request, and reads the request id or code from its own URL, so nothing a caller sends can reach the markup. What changes is answered by JSON routes beside them: the status poll the wait page drives, and the three calls the limited page makes. All of it is uncached, and all of it is locked down by the same security headers.

## `http::routes::oauth::pages`

### `content_security_policy`

**A page loads only from this origin, talks only to this origin, and can't be framed.** The one thing that differs between pages is where their forms may go: the wait page has no form, and the React pages' **Sign out** form posts here and is redirected on to the launcher.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/pages.rs content_security_policy}}

### `NO_FORM_TARGETS`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/pages.rs NO_FORM_TARGETS}}

### `page_security_headers`

Every page and asset is checked for them by [`assert_locked_down`](<../Test Fixtures Explanation.md#authorization-pages>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/pages.rs page_security_headers}}

### `request_page_location`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/pages.rs request_page_location tests="tests::a_request_page_resolves_beside_the_authorize_endpoint tests::a_request_page_location_keeps_the_id_one_segment"}}

## `http::routes::oauth::wait_page`

The wait page is where a browser waits **while the Owner decides somewhere else**: in the host's popup, in a signed-in launcher, or on a consent card. Its script polls [the status](#item-handle_authorization_status_request) until the request is decided, then follows the redirect the poll hands back. That redirect is the only address off this origin the page ever leaves for. While the request is pending, the page also checks whether this browser has since signed in as the Owner and, if so, switches to the consent card beside it. Its three files are embedded as they are, with nothing interpolated; the script has no unit tests, and the [Wait Page](<../../Integration Tests/Wait Page Explanation.md>) integration tests pin how its files are served.

### `router`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/wait_page.rs router}}

### `wait_page_location`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/wait_page.rs wait_page_location}}

### `WAIT_PAGE_HTML`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/wait_page.rs WAIT_PAGE_HTML}}

### `WAIT_PAGE_SCRIPT`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/wait_page.rs WAIT_PAGE_SCRIPT}}

### `WAIT_PAGE_STYLESHEET`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/wait_page.rs WAIT_PAGE_STYLESHEET}}

### `wait_page`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/wait_page.rs wait_page}}

### `wait_page_script`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/wait_page.rs wait_page_script}}

### `wait_page_stylesheet`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/wait_page.rs wait_page_stylesheet}}

### `page_file`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/wait_page.rs page_file}}

## `http::routes::oauth::authorization_pages`

The consent card, the limited page, the device page and the pairing page are the build of `authorization-server-web`, embedded in the binary when it is compiled. The consent card and the device page call `/authorization/*` and FHIR on the browser session's bearer, which the host's cookie-to-bearer layer presents for them. The pairing page calls [`/oauth/pair/*`](<Pairing and Sign In Explanation.md>), which needs no session. The limited page calls [`/oauth/authorize/{id}/*`](#httproutesoauthsession_shortfall), on the browser session's cookie.

The unit tests serve a [fake build](<../Test Fixtures Explanation.md#authorization-pages>) laid out as Vite lays it out, with a launcher on another origin.

### `AUTHORIZATION_PAGES`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs AUTHORIZATION_PAGES tests="tests::the_embedded_build_has_every_page"}}

### `router`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs router}}

### `sign_out_form_targets`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs sign_out_form_targets}}

### `router_for`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs router_for}}

### `page`

**A page is the same uncached bytes whatever its URL holds.**

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs page tests="tests::the_consent_card_is_the_same_uncached_page_for_every_request tests::the_limited_page_is_the_same_uncached_page_for_every_request tests::the_device_page_is_the_same_uncached_page_with_or_without_a_code tests::the_pairing_page_is_the_same_uncached_page_whatever_its_next"}}

### `asset`

**An asset is cached for a year without revalidating**, since Vite's file names carry a hash of their contents and never change under a name. Anything but a script, a stylesheet or a font is a `404`, even when the build holds it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs asset tests="tests::hashed_scripts_stylesheets_and_fonts_are_immutable_with_their_types tests::anything_but_a_built_script_stylesheet_or_font_is_not_found"}}

### `asset_content_type`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs asset_content_type}}

### `IMMUTABLE`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs IMMUTABLE}}

### `consent_page_location`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs consent_page_location}}

### `limited_page_location`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs limited_page_location tests="tests::the_limited_location_resolves_to_the_limited_page"}}

### `pairing_page_location`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs pairing_page_location tests="tests::the_pairing_location_resolves_to_the_pairing_page_carrying_next"}}

### `device_page_url`

An absolute URL, since a device shows it to a person who types it elsewhere.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs device_page_url}}

### `device_page_url_with_code`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs device_page_url_with_code tests="tests::the_device_page_urls_are_on_the_server_origin_with_the_code_encoded"}}

## `http::routes::oauth::authorization_status`

### `AuthorizationStatus`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_status.rs AuthorizationStatus}}

#### `into_response`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_status.rs AuthorizationStatus::into_response}}

### `handle_authorization_status_request`

**A leaked request id collects nothing.** The [authorization status reader](<../../Capabilities/OAuth/Authorization Status Reader Explanation.md>) enforces who may read; the handler passes it the browser session the cookie carries.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_status.rs handle_authorization_status_request}}

## `http::routes::oauth::session_shortfall`

A browser whose session holds less than an app asks for is told so on the [limited page](<../../Domain/Authorization Request/Code Request Explanation.md#the-limited-page>) before anyone else is bothered. The page makes three calls on its own origin: read what the session lacks, go on, or cancel. **Each answers only the browser session the request was made in**; any other browser, with another session or none, gets the same `404` as an unknown id.

The two posts carry no body, so another page could send them as a simple request. What refuses one is the host's cookie-to-bearer layer, which answers `403` to a write carrying the cookie from any origin but the server's. Every answer is uncached, since a Continue may carry the app's redirect with a code. The [Session Shortfall](<../../Integration Tests/Session Shortfall Explanation.md>) integration tests hold all three.

### `SessionShortfallBody`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_shortfall.rs SessionShortfallBody}}

#### `from`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_shortfall.rs SessionShortfallBody::from}}

### `SessionShortfallNextBody`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_shortfall.rs SessionShortfallNextBody}}

### `requesting_browser_session`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_shortfall.rs requesting_browser_session}}

### `next_location`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_shortfall.rs next_location}}

### `handle_session_shortfall_read`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_shortfall.rs handle_session_shortfall_read}}

### `handle_session_shortfall_continue`

The request takes the branch `/oauth/authorize` would have taken had the session held everything, and [`next_step_location`](<Authorize Explanation.md#item-next_step_location>) builds the location, under `/oauth/`, since the page follows it from elsewhere. Any other failure renders as `/oauth/authorize` would render it ([`AuthorizeError`](<Authorize Explanation.md#item-AuthorizeError>)).

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_shortfall.rs handle_session_shortfall_continue}}

### `handle_session_shortfall_cancel`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_shortfall.rs handle_session_shortfall_cancel}}
