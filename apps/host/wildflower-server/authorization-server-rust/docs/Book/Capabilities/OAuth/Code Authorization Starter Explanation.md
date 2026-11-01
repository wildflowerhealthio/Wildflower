# Code Authorization Starter

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs}}

The code authorization starter is what `/oauth/authorize` does once a browser that holds a [browser session](<../../Domain/Browser Session Explanation.md>) arrives carrying an app's request; a browser without one is sent to pair before it gets here. **It validates the request, parks it as a [code request](<../../Domain/Authorization Request/Code Request Explanation.md>), and decides where the browser goes next.** It also goes on with a request the browser has confirmed on its limited page.

Three questions about the parked request pick the next step:

1. **Does the browser's session hold everything the request asks for?** If not, and the session hasn't gone on past the limited page for this app before, the request waits on that browser's limited page, and nothing else is decided until the browser says to go on.
2. **Does a standing grant cover it?** When the request makes no change to the app's registration, a standing grant covers every scope it asks for, and a launch's patient is the grant's, the code is issued at once under the grant: the fast path. The [Grant](<../../Domain/Grant Explanation.md#when-a-grant-skips-the-owner>) page has the whole rule.
3. **Can the browser decide it itself?** Otherwise the request waits for a person. A session that may decide consents and holds the request's approval scopes is sent to the consent card; any other browser goes to the wait page while the request is raised for the Owner.

**The starter is public**: no scope opens it, because the caller is the browser of whoever opened the app. Its powers are exactly two operations, [`start`](#item-CodeAuthorizationStarter--start) and [`continue_past_session_shortfall`](#item-CodeAuthorizationStarter--continue_past_session_shortfall), each in one write scope. A request that would bother the Owner, by being raised for the Owner or parked for its limited page, first asks the authorization start limit, which the route hands in.

The tests start requests from the [starter fixtures](<../Test Fixtures Explanation.md#code-authorization-starter>): by default a request whose session holds all the Owner holds, so it falls short of nothing, from a browser that can't decide consents, and always admitted by the start limit.

## `domain::capabilities::oauth::code_authorization_starter`

### `AUTHORIZATION_REQUEST_TTL`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs AUTHORIZATION_REQUEST_TTL}}

### `AuthorizeRequest`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs AuthorizeRequest}}

### `FreshIds`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs FreshIds}}

### `AuthorizeNextStep`

The route turns each into a location ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorize.rs next_step_location}}).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs AuthorizeNextStep}}

### `AuthorizationStartError`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs AuthorizationStartError}}

### `CodeAuthorizationStarter`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs CodeAuthorizationStarter}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs CodeAuthorizationStarter::new}}

#### `start`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs CodeAuthorizationStarter::start tests="tests::no_signing_key_refuses_before_parking tests::a_request_outside_the_registration_waits_for_the_owner tests::the_requesting_browser_decides_only_a_request_it_can_approve_as_asked tests::a_launch_is_consumed_onto_the_parked_request_once tests::a_refused_request_leaves_its_launch_unspent tests::a_request_its_session_falls_short_of_waits_on_the_limited_page tests::parking_for_the_limited_page_asks_the_start_limit tests::only_a_request_raised_for_the_owner_asks_the_start_limit"}}

#### `start_in`

**The order inside the scope is the point.** Every check that can refuse the request runs first; the launch is consumed after them, so a refused request leaves its launch unspent; the request is parked last. The consume is [`consume_launch`](<Launch Contexts Explanation.md#item-consume_launch>), which [Launch Contexts](<Launch Contexts Explanation.md>) explains with its refusals. The session's shortfall is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs session_shortfall}}, against what the session's row holds ([`browser_session_grant`](<Session Shortfall Explanation.md#item-browser_session_grant>)), which an approved [session widening](<Session Widening Explanation.md>) grows; `prompt=consent` shows the limited page again after a remembered Continue. The standing grant's coverage is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs GrantCoverage::resolve}}.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs CodeAuthorizationStarter::start_in}}

#### `continue_past_session_shortfall`

The request is loaded by [`load_code_request_awaiting_limited_page`](<Session Shortfall Explanation.md#item-load_code_request_awaiting_limited_page>), and goes on through its own [`acknowledge_session_shortfall`](<../../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--acknowledge_session_shortfall>) transition, written through the [guarded replace](<../../Domain/Authorization Request Explanation.md#transitions-and-the-guarded-replace>), so a Cancel that landed first wins.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs CodeAuthorizationStarter::continue_past_session_shortfall tests="tests::continuing_past_the_shortfall_takes_the_fast_path tests::continuing_without_a_standing_grant_raises_for_the_owner tests::a_session_gone_on_for_a_client_skips_the_limited_page_for_it tests::reviewing_the_shortfall_shows_the_limited_page_after_a_continue tests::a_session_s_row_and_not_its_token_decides_the_limited_page tests::only_the_requesting_session_continues_a_request_still_waiting tests::continuing_without_a_signing_key_refuses_before_acknowledging"}}

#### `continue_in`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs CodeAuthorizationStarter::continue_in}}

#### `publish`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs CodeAuthorizationStarter::publish}}

### `Decided`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs Decided}}

### `refuse_waiting_request`

The denial is the request's own [`to_denied_on_limited_page`](<../../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--to_denied_on_limited_page>), the same transition as the limited page's Cancel. The Owner never saw the request, so nothing is republished.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs refuse_waiting_request tests="tests::continuing_for_a_client_disabled_since_denies_the_request"}}

### `fast_path_coverage`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs fast_path_coverage tests="tests::a_launch_bound_patient_the_grant_does_not_name_waits_for_the_owner"}}

### `decide`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs decide}}

### `issue_under_standing_grant`

The writer is the same one the Owner's approval goes through, {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs RequestApprover::approve_for_code}}, which bounds the code by the requesting browser's session and stamps the grant used.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs issue_under_standing_grant tests="tests::a_fully_covered_registered_request_is_issued_a_code_without_a_human tests::the_fast_path_denies_a_request_whose_browser_session_is_revoked tests::a_code_issued_under_the_standing_grant_stamps_it_used tests::a_partially_covering_grant_is_not_stamped_used"}}

### `parse_redirect_uri`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs parse_redirect_uri}}

### `validate_code_params`

The server's origin is also its FHIR base and the `iss` every launch hands the app, so an `aud` names this server exactly when it equals the origin.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs validate_code_params tests="tests::aud_must_name_this_server"}}

### `launch_refusal_kind`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs launch_refusal_kind tests="tests::a_launch_for_another_client_reads_like_a_forged_one tests::an_expired_launch_is_refused_as_expired tests::a_consumed_launch_is_refused_as_already_used"}}

### `start_error`

**Whom a failure is told to depends on whether the redirect can be trusted**: a redirect is trusted only when a client the server already knows registered it. Sending an error to an untrusted redirect would make the server an open redirector.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs start_error tests="tests::unknown_clients_park_and_untrusted_redirects_fail_locally tests::trusted_redirects_get_redirectable_errors_and_the_host_is_clamped"}}
