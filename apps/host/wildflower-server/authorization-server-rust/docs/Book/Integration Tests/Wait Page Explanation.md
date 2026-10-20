# Wait Page

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/wait_page.rs}}

When an app's request is parked for the Owner and the browser that made it can't decide it, `/oauth/authorize` sends that browser to the wait page. The person at the browser waits there while the Owner decides on their own device; the page polls the request's status and follows wherever the decision sends it. These tests hold the server to how it sends the browser there and how it serves the page: on its own origin, beside the endpoint, the same static bytes for every request, locked to that origin.

The page's script has no tests of its own; [`the_wait_page_checks_the_browser_session`](#item-the_wait_page_checks_the_browser_session) reads one line of it.

This file's own helpers are on the [Test Fixtures](<Test Fixtures Explanation.md#integrationwait_page>) page, with the shared ones.

## `integration::wait_page`

### `a_parked_request_waits_beside_the_authorize_endpoint`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/wait_page.rs a_parked_request_waits_beside_the_authorize_endpoint}}

Relies on [`wait_page_location`](<../HTTP/Routes/Authorization Pages Explanation.md#item-wait_page_location>). Fixtures first used here: [`spin_up`](<Test Fixtures Explanation.md#item-spin_up>), [`get_authorize`](<Test Fixtures Explanation.md#item-get_authorize>), [`authorize_query`](<Test Fixtures Explanation.md#item-authorize_query>), [`parked_request_id`](<Test Fixtures Explanation.md#item-parked_request_id>), [`location_of`](<Test Fixtures Explanation.md#item-location_of>) and [`LAUNCHER_BASE`](<Test Fixtures Explanation.md#item-LAUNCHER_BASE>).

### `the_wait_page_is_static_and_locked_down`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/wait_page.rs the_wait_page_is_static_and_locked_down}}

Relies on [`router`](<../HTTP/Routes/Authorization Pages Explanation.md#item-wait_page--router>), which serves the three files embedded as they are. Fixtures first used here: [`get`](<Test Fixtures Explanation.md#item-get>), [`header`](<Test Fixtures Explanation.md#item-header>) and [`body_string`](<Test Fixtures Explanation.md#item-body_string>).

### `the_wait_page_assets_are_served_beside_it`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/wait_page.rs the_wait_page_assets_are_served_beside_it}}

Relies on [`router`](<../HTTP/Routes/Authorization Pages Explanation.md#item-wait_page--router>).

### `the_wait_page_checks_the_browser_session`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/wait_page.rs the_wait_page_checks_the_browser_session}}

Relies on [`SESSION_HEADER`](<../HTTP/Browser Session Cookie Explanation.md#item-SESSION_HEADER>) and [`BROWSER_SESSION_HEADER_VALUE`](<../HTTP/Browser Session Cookie Explanation.md#item-BROWSER_SESSION_HEADER_VALUE>).
