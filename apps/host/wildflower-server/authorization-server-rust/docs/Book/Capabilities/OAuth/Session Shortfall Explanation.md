# Session Shortfall

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs}}

A browser paired with read-only access may run an app that asks for write. A code earned in that browser carries only what its session holds, so **the person at the browser is told first, on the limited page, before the Owner is asked anything**. The [code authorization starter](<Code Authorization Starter Explanation.md#start>) parks such a request unacknowledged and sends the browser to the page. The page then reads what the session lacks, and the person goes on ([`continue_past_session_shortfall`](<Code Authorization Starter Explanation.md#continue_past_session_shortfall>), on the starter) or cancels (here).

**Every operation answers only the browser session the request was made in**, so a leaked request id reads, continues and cancels nothing. The capability is public in the sense that no scope opens it: the caller is the browser that made the request, known by its browser session, and reading and cancelling are its only powers. The [Session Shortfall integration tests](<../../Integration Tests/Session Shortfall Explanation.md>) drive the whole page over HTTP; the request's own transitions are [`acknowledge_session_shortfall`](<../../Domain/Authorization Request Explanation.md#acknowledge_session_shortfall>) and [`deny_on_limited_page`](<../../Domain/Authorization Request Explanation.md#deny_on_limited_page>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs SessionShortfall}}

`new` builds it over a store handle lifted from the state.

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs SessionShortfall::new}}

## Test fixtures

`code_request` is a code request from the fixture client `client`, asking for `openid`, `patient/Patient.r` and `patient/Observation.r`, made in the fixture browser session, waiting on its limited page or gone on past it:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs tests::code_request}}

`unacknowledged` is that request, live for five minutes, still waiting on the page:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs tests::unacknowledged}}

`status_of` reads a request's status back from the store:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs tests::status_of}}

`browser_session` is the calling browser: its `sid` and the grant its session holds.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs tests::browser_session}}

## `load_unacknowledged_code_request`

**A request is on its limited page while it is a pending, unexpired code request, made in this browser session, that hasn't gone on yet.** This is the one load the read, the Cancel and the starter's Continue share. Anything else, whether an unknown id, another session's request, one gone on already, one decided or one expired, is `AuthorizationRequestNotFound`: the same `404` the status poll gives an unknown id, so the answer says nothing about whether the id exists.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs load_unacknowledged_code_request}}

It leans on [`into_pending_code`](<../../Domain/Authorization Request Explanation.md#into_pending_code>) for "pending, unexpired and a code request", then checks the two facts the limited page adds: the `session_shortfall_acknowledged` flag and the request's `sid`.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs tests::only_the_requesting_session_reads_a_request_still_waiting_on_its_page}}

A waiting request read from another session, a request already gone on, an expired one, a denied one and an unknown id are all not found, and Cancel finds none of them either.

## `SessionShortfallView`

What the limited page shows: who is asking, and what the session would not pass on.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs SessionShortfallView}}

| Field            | The fact it carries                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client_name`    | The app's registered name, or its `client_id` when it has no registration yet (a client trusted on first use, asking for the first time).                    |
| `missing_scopes` | The requested scopes a code issued in this session would not carry in full, in the request's order: dropped outright, or narrowed to what the session holds. |

## `read`

**The page reads what the request asks for that the session doesn't hold, and the app asking.** It runs in a read scope. The missing scopes come from {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs session_shortfall}}, against the grant the calling browser's session carries, the same check the starter made when it parked the request.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs SessionShortfall::read}}

The calling browser arrives as a {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs PollingBrowserSession}}, the same shape the wait page's poll uses: its `sid` and its grant.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs tests::the_read_names_the_app_and_what_the_session_lacks}}

The session holds `patient/Patient.rs`, which covers `patient/Patient.r`, so only `patient/Observation.r` is missing. `openid` isn't held access, so a session never lacks it. The app is named by its registration.

Exercised end to end by [`the_fast_path_stops_at_the_limited_page_then_issues_the_narrowed_code`](<../../Integration Tests/Session Shortfall Explanation.md#the_fast_path_stops_at_the_limited_page_then_issues_the_narrowed_code>), [`another_browser_can_neither_read_nor_continue_nor_cancel`](<../../Integration Tests/Session Shortfall Explanation.md#another_browser_can_neither_read_nor_continue_nor_cancel>) and [`an_expired_request_on_the_limited_page_goes_no_further`](<../../Integration Tests/Session Shortfall Explanation.md#an_expired_request_on_the_limited_page_goes_no_further>), through the route's {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_shortfall.rs handle_session_shortfall_read}}.

## `cancel`

**Cancel denies the request and sends the browser back to the app with `access_denied`.** The denial lands only while the request still waits on its page: it goes through the guarded replace ([`write_transition`](<../../Grant Store/Authorization Requests Explanation.md#write_transition>)), so if a Continue acknowledged the request in the meantime, the Continue wins and Cancel answers not found. The Owner was never told about a request still waiting here, so nothing is republished to the Owner's popup.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs SessionShortfall::cancel}}

The callback is built after the write scope closes, from the request as it was loaded: its redirect, `access_denied`, the declined sentence, and the app's `state`. **Cancel isn't remembered.** Unlike Continue, it records nothing for the session and the app, so the browser's next request for the app stops at the page again.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs tests::cancel_denies_the_request_and_answers_access_denied}}

The callback carries `error=access_denied`, the declined description and the app's `state`. The request is denied, no acknowledgement is recorded for the session and the client, and a second Cancel finds nothing.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs tests::a_cancel_racing_a_continue_leaves_the_acknowledged_request_alone}}

The race, step by step: Cancel loads the request, then Continue acknowledges it and its replace lands. Cancel's denial, built from its earlier read, is still a valid transition on paper, but its replace finds the row in another phase and writes nothing. The request stays pending, gone on past its page.

Exercised end to end by [`cancel_answers_the_app_access_denied`](<../../Integration Tests/Session Shortfall Explanation.md#cancel_answers_the_app_access_denied>) and [`another_browser_can_neither_read_nor_continue_nor_cancel`](<../../Integration Tests/Session Shortfall Explanation.md#another_browser_can_neither_read_nor_continue_nor_cancel>), through the route's {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_shortfall.rs handle_session_shortfall_cancel}}.
