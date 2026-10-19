# Wait Page

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/wait_page.rs}}

When an app's request is parked for the Owner and the browser that made it can't decide it, `/oauth/authorize` sends that browser to the wait page. The person at the browser waits there while the Owner decides on their own device; the page polls the request's status and follows wherever the decision sends it. These tests hold the server to how it sends the browser there and how it serves the page: on its own origin, beside the endpoint, the same static bytes for every request, locked to that origin.

The page's script has no tests of its own; [`the_wait_page_checks_the_browser_session`](#the_wait_page_checks_the_browser_session) reads one line of it. Why a request parks at all is on [the Authorization Request page](<../Domain/Authorization Request Explanation.md>), and the browser session the page asks about on [the Browser Session page](<../Domain/Browser Session Explanation.md>).

## Helpers

Two local helpers: a `GET` with no cookie, and a header the response must carry.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/wait_page.rs get}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/wait_page.rs header}}

## `a_parked_request_waits_beside_the_authorize_endpoint`

**A parked request is sent to a wait page beside the endpoint it asked, by a relative address.** Resolved against `/oauth/authorize`, the `Location` is `/oauth/authorize/{id}/wait`, on whatever origin the browser used, and it names no launcher address.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/wait_page.rs a_parked_request_waits_beside_the_authorize_endpoint}}

Relies on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/wait_page.rs wait_page_location}}; parks the request with [`get_authorize`](<../Integration Tests Explanation.md#get_authorize>) and reads it with [`parked_request_id`](<../Integration Tests Explanation.md#parked_request_id>).

## `the_wait_page_is_static_and_locked_down`

**The wait page is the same bytes whatever request id its path names, so an id never reaches the markup.** A path holding a script tag gets the same body as an ordinary one. The page is also served as HTML with a content security policy that allows only its own origin's scripts, styles, fonts and connections and no framing, a same-origin referrer policy, `nosniff`, and `Cache-Control: no-store`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/wait_page.rs the_wait_page_is_static_and_locked_down}}

Relies on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/wait_page.rs router}}, which serves the three files embedded as they are.

## `the_wait_page_assets_are_served_beside_it`

**The page's script and stylesheet are served where its relative references lead.** The page asks for `../wait.js` and `../wait.css`; both are served under `/oauth/authorize/`, with the JavaScript and CSS content types `nosniff` requires and `Cache-Control: no-store`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/wait_page.rs the_wait_page_assets_are_served_beside_it}}

Relies on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/wait_page.rs router}}.

## `the_wait_page_checks_the_browser_session`

**When the page checks whether this browser can open the consent card, it asks as the browser session, as the card does.** The script sends the `wildflower-session: browser` header, so a browser that also holds the FHIR web UI's session is judged by its browser session.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/wait_page.rs the_wait_page_checks_the_browser_session}}

Relies on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs SESSION_HEADER}} and {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs BROWSER_SESSION_HEADER_VALUE}}.
