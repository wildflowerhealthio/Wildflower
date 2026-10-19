# Session Shortfall

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs}}

A browser paired with read-only access may run an app that asks for more. The code it earns would carry only what its session holds, so **the browser is told first, on the limited page, before anyone else is bothered**. `/oauth/authorize` parks the request unacknowledged and sends the browser to `/oauth/authorize/{id}/limited`. The page reads what the session lacks, then goes on (`…/continue`) or cancels (`…/cancel`).

Until the browser goes on, the Owner isn't asked and nothing decides the request. Going on takes the branch the start would have taken: the fast path under a standing grant, the consent card, or the wait page. Only the browser that made the request can read, continue or cancel it. Once a browser session has gone on for an app, its later requests for that app skip the page.

The request's two limited-page transitions are [`acknowledge_session_shortfall`](<../Domain/Authorization Request Explanation.md#acknowledge_session_shortfall>) and [`deny_on_limited_page`](<../Domain/Authorization Request Explanation.md#deny_on_limited_page>). What the session lacks is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs session_shortfall}}. The page's calls are the harness's [`limited_request_id`](<../Integration Tests Explanation.md#limited_request_id>), [`get_session_shortfall`](<../Integration Tests Explanation.md#get_session_shortfall>), [`post_session_shortfall`](<../Integration Tests Explanation.md#post_session_shortfall>) and [`continue_past_session_shortfall`](<../Integration Tests Explanation.md#continue_past_session_shortfall>).

## Helpers

The app asks for `patient/Patient.rs patient/Observation.rs offline_access`. `limited_browser` is a browser that holds `patient/Patient.rs` and `wildflower/launch` alone, so it lacks `patient/Observation.rs`:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs limited_browser}}

`approve_a_standing_grant` leaves a standing grant for the app, earned by the harness's paired browser, which lacks nothing:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs approve_a_standing_grant}}

## `the_fast_path_stops_at_the_limited_page_then_issues_the_narrowed_code`

**A standing grant covers the request, but the session falls short of it, so the browser stops at the limited page with nothing issued and nothing raised.** The page's read names the app and `patient/Observation.rs`, uncached. Going on issues a code narrowed to the session, `patient/Patient.rs offline_access`, still without asking the Owner. A second Continue is a `404`: a request goes on once.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs the_fast_path_stops_at_the_limited_page_then_issues_the_narrowed_code}}

Relies on [`acknowledge_session_shortfall`](<../Domain/Authorization Request Explanation.md#acknowledge_session_shortfall>) and {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs CodeAuthorizationStarter::continue_past_session_shortfall}}.

## `the_owner_neither_sees_nor_decides_a_request_waiting_on_its_limited_page`

**A request its own browser hasn't gone on with isn't the Owner's to see or decide.** The newest pending consent skips it. The Owner's consent read, approve, deny and ask-owner all answer `404`. Once the browser goes on, to the wait page, the request becomes the newest pending consent and the Owner approves it.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs the_owner_neither_sees_nor_decides_a_request_waiting_on_its_limited_page}}

Relies on [`acknowledge_session_shortfall`](<../Domain/Authorization Request Explanation.md#acknowledge_session_shortfall>) and [`NewestPendingConsent`](<../Domain/Pending Consent Explanation.md>).

## `without_a_standing_grant_continue_raises_the_request_for_the_owner`

**With no standing grant, going on raises the request for the Owner on the wait page, even from a browser that can decide consents.** A code approval takes every held access the request asks for, and the shortfall is held access the session lacks. Here that is `wildflower/launch` alone, so the session can't approve the request on its own card. Its consent read lists `wildflower/launch` as the missing approval scope, and the pending consent says it can't be decided in its browser. A plain limited browser takes the same path to the wait page.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs without_a_standing_grant_continue_raises_the_request_for_the_owner}}

Relies on [`NewestPendingConsent`](<../Domain/Pending Consent Explanation.md>) and on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovableScopes::missing_approval_scopes}}, which decides between the consent card and the wait page.

## `cancel_answers_the_app_access_denied`

**Cancel denies the request and sends the browser back to the app with `access_denied`.** The request can't be continued or read afterwards, and its status reads `denied`. Cancel isn't remembered: the browser's next request for the app stops at the limited page again.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs cancel_answers_the_app_access_denied}}

Relies on [`deny_on_limited_page`](<../Domain/Authorization Request Explanation.md#deny_on_limited_page>), through {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs SessionShortfall::cancel}}.

## `continue_for_an_app_disabled_since_denies_the_request`

**If the app was disabled while the browser sat on the limited page, Continue ends the request.** The request is denied, and the page's JSON carries the app's `access_denied` callback, saying the client has been disabled.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs continue_for_an_app_disabled_since_denies_the_request}}

Relies on [`deny_on_limited_page`](<../Domain/Authorization Request Explanation.md#deny_on_limited_page>).

## `a_session_that_went_on_for_an_app_skips_the_limited_page_for_it`

**The limited page is shown once per browser session per app.** After going on once, the same session's next request for the app takes the fast path at once, narrowed as before. Another session, and the same session asking for another app, still stop at the page.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs a_session_that_went_on_for_an_app_skips_the_limited_page_for_it}}

Relies on the per-session, per-client acknowledgement that {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs CodeAuthorizationStarter::continue_past_session_shortfall}} records.

## `another_browser_can_neither_read_nor_continue_nor_cancel`

**Only the browser that made the request can act on its limited page.** Another limited browser, the Owner's signed-in session, and a browser with no session all get the `404` an unknown id gets on the read, Continue and Cancel. The request still waits for its own browser.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs another_browser_can_neither_read_nor_continue_nor_cancel}}

Relies on the `sid` of the [code request](<../Domain/Authorization Request Explanation.md#the-code-request>), which {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs load_unacknowledged_code_request}} compares with the calling browser's.

## `an_expired_request_on_the_limited_page_goes_no_further`

**A request whose five minutes ran out on the limited page can't be read, continued or cancelled.** Its status poll reports it expired, as for any other request.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs an_expired_request_on_the_limited_page_goes_no_further}}

Relies on [`pending_at`](<../Domain/Authorization Request Explanation.md#pending_at>).

## `an_owner_session_never_sees_the_limited_page`

**The Owner's session holds everything, so it never falls short.** Its request goes to the consent card, or, once a standing grant covers it, straight back to the app with a code.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs an_owner_session_never_sees_the_limited_page}}

Relies on [`new_owner`](<../Domain/Browser Session Explanation.md#new_owner>).
