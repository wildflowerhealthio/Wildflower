# Code Authorization Starter

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs}}

The code authorization starter is what `/oauth/authorize` does once a browser with a browser session arrives carrying an app's request (a browser without one is sent to pairing before it gets here). **It validates the request, parks it, and decides where the browser goes next**: to its limited page, to the Owner (on the consent card or the wait page), or straight back to the app with a code under a standing grant. It also goes on with a request the browser has confirmed on its limited page.

The [Grant Flows story](<../../Integration Tests/Grant Flows Explanation.md#the-story>) walks this flow end to end: the three questions that pick the next step, the Owner's decision, the fast path and redemption. Read it first. This page goes through the starter one function at a time, with the unit tests for each.

**The starter is public: no scope opens it, because the caller is the browser of whoever opened the app.** So its powers are exactly two operations, [`start`](#start) and [`continue_past_session_shortfall`](#continue_past_session_shortfall). Each runs in one write scope. A refusal returned as an `Err` from inside the scope rolls everything back, including a spent launch. The Owner's popup is told about a new pending consent only after the scope commits ([`publish`](#publish)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs CodeAuthorizationStarter}}

`server_origin` is `https://<domain>`, which is also the server's FHIR base, so a SMART `aud` must name it. `owner_approval` is the port that republishes the newest pending consent to the Owner's popup. `new` builds the starter from the three; the live binding lifts them from the state.

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs CodeAuthorizationStarter::new}}

## `AUTHORIZATION_REQUEST_TTL`

**A parked request lives five minutes**, from its start, and again from the moment its browser goes on past the limited page.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs AUTHORIZATION_REQUEST_TTL}}

No unit test of its own; its restart on Continue is asserted under [`continue_past_session_shortfall`](#continue_past_session_shortfall).

## `AuthorizeRequest`

The request as the app's browser presented it (RFC 6749 §4.1.1 with PKCE, plus the SMART App Launch parameters), and the facts about the browser that the handler worked out before calling in.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs AuthorizeRequest}}

| Field                                                      | The fact it carries                                                                                                                                                                             |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `response_type`, `code_challenge_method`, `code_challenge` | The OAuth and PKCE parameters, as presented. Only `code` and `S256` are accepted.                                                                                                               |
| `client_id`, `redirect_uri`, `scope`, `client_state`       | The app, where it wants the answer, what it asks for (space-separated), and its `state`, echoed back on every answer.                                                                           |
| `launch`                                                   | The SMART `launch` value the app was launched with; `None` for plain OAuth.                                                                                                                     |
| `aud`                                                      | The FHIR server the app means to call; `None` when the app doesn't say.                                                                                                                         |
| `browser_session_grant`                                    | What the browser's session holds. A code issued here carries no more, so a request asking for more waits on the limited page.                                                                   |
| `can_decide_consents`                                      | Whether that session may decide consents at all. With `browser_session_grant` it settles whether the request can be decided in this browser.                                                    |
| `may_raise_for_owner`                                      | The authorization start limit, asked at most once, only when the request is about to be raised for the Owner or parked for its limited page. Always yes for a start the limit already admitted. |
| `sid`                                                      | The browser session the request is made in. It is recorded on the parked request and on any code it earns.                                                                                      |

`may_raise_for_owner` is a closure, not a flag, so that a browser able to decide its own requests spends nothing from the limit for them: the limit is only asked once the starter knows the request will bother the Owner. The [Authorization Start Limit tests](<../../Integration Tests/Authorization Start Limit Explanation.md>) hold the route to this.

## `FreshIds`

The two identifiers a start may need, minted by the caller (a random UUID and a random code) so that tests can name them. The code is used only if the request is issued one on the spot.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs FreshIds}}

## `AuthorizeNextStep`

Where the browser goes when the start succeeds.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs AuthorizeNextStep}}

| Step                      | Where the browser goes                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `RedirectToClient`        | Back to the app's redirect with a code and its `state`: the fast path.                                                        |
| `AwaitOwner`              | The consent card, in this browser, when `decidable_in_requesting_browser`; otherwise the wait page, while the Owner is asked. |
| `ConfirmSessionShortfall` | The limited page. Nothing is issued and the Owner isn't asked yet.                                                            |

The route turns each into a location ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorize.rs next_step_location}}).

## `AuthorizationStartError`

The ways a start can fail, and how each reaches the person and the app.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs AuthorizationStartError}}

| Error                | What it means                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NoActiveSigningKey` | The server can't sign tokens, so it refuses before parking a request it could never complete.                                                                            |
| `LocalPage`          | A failure shown as this server's own page, because the `redirect_uri` isn't trusted. Sending an error to an untrusted redirect would make the server an open redirector. |
| `Redirectable`       | A failure sent back to the app's (trusted) redirect, with the OAuth error, a sentence for `error_description`, and the app's `state` (RFC 6749 §4.1.2.1).                |
| `RequestNotPending`  | The request this flow just parked was no longer pending when the fast path approved it: a concurrent transition. It rolls the scope back.                                |
| `StartLimited`       | The start limit refused to let the request bother the Owner. Nothing is parked.                                                                                          |
| `Store`              | A store failure, or, from a Continue, `AuthorizationRequestNotFound` for a request no longer on its limited page.                                                        |

## Test fixtures

Every test starts from the same shape: a request from `client_id` asking for `scope`, made in the browser session `REQUESTING_SID`, whose grant holds all the Owner holds (`OWNER_SESSION_GRANT`), so by default it falls short of nothing, can't decide consents, and is always admitted by the start limit.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::CHALLENGE}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::SERVER_ORIGIN}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::REQUESTING_SID}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::OWNER_SESSION_GRANT}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::request}}

`ids` mints `req-1` and `the-code`:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::ids}}

`starter` seeds an active signing key and stores `REQUESTING_SID` as an approved browser session. **That stored session holds only `wildflower/launch`.** The request's `browser_session_grant` is what the starter checks for a shortfall; the stored session is what the approval bounds the code by. The two differ on purpose in `continuing_past_the_shortfall_takes_the_fast_path`, under [`continue_past_session_shortfall`](#continue_past_session_shortfall). It also returns the recording popup port, whose `count` is how many times the newest pending consent was republished.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::starter}}

`registered_app_starter` registers `app` for `openid` with no standing grant, so every valid request from it waits for the Owner:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::registered_app_starter}}

The launch tests plant and spend launches in the starter's own store through `StoredLaunches`:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::StoredLaunches}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::StoredLaunches::mint}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::StoredLaunches::mint_for_any_client}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::StoredLaunches::consume}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::launch_contexts_of}}

`launch_refusal_description` presents a launch as the registered `app` and returns the `invalid_request` sentence it was refused with; `launch_refusal_page` presents it as `newcomer`, whose redirect is untrusted, and returns the local page it got:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::launch_refusal_description}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::launch_refusal_page}}

The limited-page tests use a store where `app` is registered for three scopes and a standing grant covers them all, so without a shortfall the request would take the fast path:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::covered_app_store}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::COVERED_SCOPES}}

`park_for_the_limited_page` starts that request from a session holding only `patient/Patient.rs`, so it parks as `req-1` on its limited page:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::park_for_the_limited_page}}

## `start`

**A start runs every check that can refuse the request, spends its launch, parks it, and then decides.** All of it happens in one write scope (`start_in`); the popup is told after the commit.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs CodeAuthorizationStarter::start}}

The order inside the scope is the point:

1. A signing key must exist, or nothing is parked.
2. The client and redirect are resolved against the registration, then the redirectable parameters are checked ([validation](#validate_code_params)).
3. The facts behind the three questions are worked out: decidable in this browser, standing-grant coverage, and the shortfall (shown in [Grant Flows](<../../Integration Tests/Grant Flows Explanation.md#three-questions-decide-where-the-browser-goes>)).
4. A request that will wait on its limited page asks the start limit.
5. The launch is consumed, [last of all](#launch_refusal_kind).
6. The request is built, and either parked for the [limited page](#parking-for-the-limited-page) or handed to [`decide`](#decide).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs CodeAuthorizationStarter::start_in from="if !tx.has_active_signing_key()" through="if !tx.has_active_signing_key()"}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::no_signing_key_refuses_before_parking}}

With no signing key in the store, the start fails with `NoActiveSigningKey` and no request is stored.

Exercised end to end by most of the [Grant Flows](<../../Integration Tests/Grant Flows Explanation.md>) and [OAuth Endpoints](<../../Integration Tests/OAuth Endpoints Explanation.md>) tests, starting with [`auth_code_grant_happy_path_end_to_end`](<../../Integration Tests/Grant Flows Explanation.md#auth_code_grant_happy_path_end_to_end>), through the route's {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorize.rs handle_authorize_request}}.

## `validate_code_params`

**What is checked, and whom the failure is told to, depends on whether the redirect can be trusted.** First the client and the redirect:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs CodeAuthorizationStarter::start_in from="let maybe_existing_client" through="&& !resolved.scopes_are_registered()"}}

The request is resolved against its client's registration ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs ResolvedCodeRequest}}, see the [client](<../../Domain/Client Explanation.md>) page):

- **A disabled client is refused** on a local page.
- **A redirect is trusted only when a client we already know registered it.**
- **A server-defined registration is fixed.** A redirect outside it is a local page; a scope outside it is `invalid_scope` back to the (trusted) redirect.
- **Any other client is trusted on first use.** A request outside its registration isn't refused: it is parked with a warning for the Owner and never takes the fast path. While its redirect is untrusted, every later failure renders locally.

The redirect itself must parse as an `http` or `https` URL, or the failure is always local:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs parse_redirect_uri}}

Then the parameters the spec lets the server send back to the app: `response_type=code`, the `S256` PKCE method with a well-formed challenge, and an `aud`, if given, that is exactly this server's origin. The origin is also the FHIR base and the `iss` every launch hands the app, so `aud` names this server exactly when it equals the origin; a trailing slash, a path or another scheme doesn't.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs validate_code_params}}

Each failure goes through `start_error`, which is where the trust decision lands: the OAuth error and the local kind's sentence to a trusted redirect, else the local page.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs start_error}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::unknown_clients_park_and_untrusted_redirects_fail_locally}}

An unknown client's request is parked for the Owner. The same client's `response_type=token` is a local page, as its redirect is unvouched-for. A server-defined client presenting a redirect it didn't register is refused outright on a local page.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::trusted_redirects_get_redirectable_errors_and_the_host_is_clamped}}

Once the server-defined client's registered redirect is used, `response_type=token` goes back to the app as `unsupported_response_type`, and a scope outside its registration as `invalid_scope` with the not-registered sentence.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::a_request_outside_the_registration_waits_for_the_owner}}

`app` is registered for `openid` only and holds a standing grant covering `patient/Patient.r` too. Asking for both, it still waits for the Owner, with nothing pre-approved, and the popup is told.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::aud_must_name_this_server}}

Only the exact origin passes. Every near miss is `invalid_request` to the registered app's redirect, and the `InvalidAudience` local page for `newcomer`.

Exercised end to end by [`authorize_unknown_client_renders_later_failures_locally`](<../../Integration Tests/OAuth Endpoints Explanation.md#authorize_unknown_client_renders_later_failures_locally>), [`authorize_validates_redirect_uri_before_pkce_method`](<../../Integration Tests/OAuth Endpoints Explanation.md#authorize_validates_redirect_uri_before_pkce_method>), [`authorize_unsupported_response_type_redirects_back`](<../../Integration Tests/OAuth Endpoints Explanation.md#authorize_unsupported_response_type_redirects_back>), [`authorize_unsupported_pkce_method_redirects_invalid_request`](<../../Integration Tests/OAuth Endpoints Explanation.md#authorize_unsupported_pkce_method_redirects_invalid_request>), [`authorize_host_app_disallowed_scope_still_redirects_invalid_scope`](<../../Integration Tests/OAuth Endpoints Explanation.md#authorize_host_app_disallowed_scope_still_redirects_invalid_scope>), [`authorize_disabled_client_is_still_rejected`](<../../Integration Tests/OAuth Endpoints Explanation.md#authorize_disabled_client_is_still_rejected>) and [`a_disabled_client_is_refused_at_authorize_until_re_enabled`](<../../Integration Tests/Client Management Explanation.md#a_disabled_client_is_refused_at_authorize_until_re_enabled>).

## `launch_refusal_kind`

**The launch is consumed last, after every check that can refuse the request.** A refusal after the consume (the start limit in [`decide`](#decide), say) rolls the scope back, so a refused request leaves its launch unspent. A launch that was consumed is carried onto the parked request, with any patient it pins.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs CodeAuthorizationStarter::start_in from="// Consume the launch last" through="let launch_context = match"}}

The consume and its four refusals are [`consume_launch`](<Launch Contexts Explanation.md#consume_launch>). A refusal is `invalid_request`, sent through `start_error` like the other parameter failures. **What the app is told hides another app's launch:** it reads exactly like a forged one. Only the server's log, which records the real refusal, tells the two apart.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs launch_refusal_kind}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::a_launch_is_consumed_onto_the_parked_request_once}}

The first start parks `req-1` carrying `launch-1` and no pinned patient. The same launch again is `invalid_request` saying it was already used, and `req-2` is never parked.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::a_launch_for_another_client_reads_like_a_forged_one}}

Another app's launch and a forged one get the same sentence and the same local page. The other app's launch is still unspent for its own app, and a request with no launch is plain OAuth.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::an_expired_launch_is_refused_as_expired}}

At the TTL, a launch for `app` is refused as expired to the redirect, and a launch for any app as the `LaunchExpired` page.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::a_consumed_launch_is_refused_as_already_used}}

Both kinds of launch, once spent, are refused as already used, to the redirect and on the local page.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::a_refused_request_leaves_its_launch_unspent}}

A wrong `aud` refuses the request, and the launch it presented can still be consumed afterwards.

Exercised end to end by [`authorize_consumes_a_smart_launch_once`](<../../Integration Tests/OAuth Endpoints Explanation.md#authorize_consumes_a_smart_launch_once>), [`authorize_refuses_a_bad_smart_launch_or_aud`](<../../Integration Tests/OAuth Endpoints Explanation.md#authorize_refuses_a_bad_smart_launch_or_aud>), [`authorize_renders_a_bad_smart_launch_locally_for_an_untrusted_redirect`](<../../Integration Tests/OAuth Endpoints Explanation.md#authorize_renders_a_bad_smart_launch_locally_for_an_untrusted_redirect>) and [`an_expired_launch_and_an_unknown_one_go_back_to_the_app_saying_why`](<../../Integration Tests/Session Required Explanation.md#an_expired_launch_and_an_unknown_one_go_back_to_the_app_saying_why>).

## Parking for the limited page

**A request asking for more than its browser session holds waits on that browser's limited page, unless the session has gone on past the page for this app before.** The shortfall is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs session_shortfall}}; the "before" is a per-session, per-client record written by [Continue](#continue_past_session_shortfall).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs CodeAuthorizationStarter::start_in from="let waits_on_limited_page" through="if waits_on_limited_page && !(authorize_query.may_raise_for_owner)()" from="// The session falls short" through="if waits_on_limited_page {"}}

Parking writes a request and spends its launch, so it **asks the start limit, as raising a request for the Owner does**. Continue later raises it without asking again. The request is parked with `session_shortfall_acknowledged: false`, and that is all: no code, no grant check acted on, nothing for the Owner, so nothing is republished. Until the browser goes on, the request is invisible to the Owner.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::a_request_its_session_falls_short_of_waits_on_the_limited_page}}

The standing grant covers the request, but the session holds only `patient/Patient.rs`. The start answers `ConfirmSessionShortfall`; the request is pending, unacknowledged, and carries its spent launch. No code exists, the popup wasn't told, and there is no newest pending consent.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::parking_for_the_limited_page_asks_the_start_limit}}

With the limit refusing, the start is `StartLimited`, nothing is parked, and the launch can still be consumed.

Exercised end to end by [`the_fast_path_stops_at_the_limited_page_then_issues_the_narrowed_code`](<../../Integration Tests/Session Shortfall Explanation.md#the_fast_path_stops_at_the_limited_page_then_issues_the_narrowed_code>) and [`a_deciding_browser_s_request_parked_for_the_limited_page_asks_the_gate`](<../../Integration Tests/Authorization Start Limit Explanation.md#a_deciding_browser_s_request_parked_for_the_limited_page_asks_the_gate>).

## `decide`

**The shared tail of a start and a Continue, for a request whose session holds all it asks for, or whose browser has said to go on.** It is where the fast path and the Owner part ways.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs decide}}

1. **The fast path applies when the standing grant covers the request in full and the launch admits the grant's patient** ([`admits_patient`](<../../Domain/Authorization Request Explanation.md#admits_patient>)). `Full` coverage is a {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs StandingGrantCoverage}} proof, built only by {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs GrantCoverage::resolve}}.
2. **Only a request about to be raised for the Owner asks the start limit**: not on the fast path, and not when the requesting browser can decide it itself.
3. `park` writes the request: the start inserts it, Continue marks its shortfall acknowledged. Every outcome after this point refers to the request by id, the fast path included.
4. The fast path issues the code ([`issue_under_standing_grant`](#issue_under_standing_grant)); otherwise the answer is `AwaitOwner`, carrying whether this browser decides it, as recorded on the request.

The popup is republished either way: a request raised for the Owner is newly pending, and one the fast path approved may have been the newest pending consent for the width of the approval.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::the_requesting_browser_decides_only_a_request_it_can_approve_as_asked}}

A browser that may decide consents and holds `patient/Observation.rs` still can't decide a request for it unless it also holds `wildflower/Grant.c` and `wildflower/Client.cu`, the power to record what an approval records. Without them the request is raised for the Owner; with them it is decided in place. Which approval scopes a request needs is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovableScopes::missing_approval_scopes}}.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::only_a_request_raised_for_the_owner_asks_the_start_limit}}

Refused by the limit, a request for the Owner is `StartLimited`, nothing is parked and the popup isn't told. A request the browser decides itself never calls the limit (the closure would panic).

Exercised end to end by [`a_browser_signed_in_as_the_owner_goes_to_the_consent_card`](<../../Integration Tests/Consent Card Explanation.md#a_browser_signed_in_as_the_owner_goes_to_the_consent_card>), [`a_browser_session_that_cannot_decide_consents_goes_to_the_wait_page`](<../../Integration Tests/Consent Card Explanation.md#a_browser_session_that_cannot_decide_consents_goes_to_the_wait_page>), [`a_browser_session_without_grant_create_goes_to_the_wait_page`](<../../Integration Tests/Approval Scopes Explanation.md#a_browser_session_without_grant_create_goes_to_the_wait_page>), [`a_deciding_browser_s_request_raised_for_the_owner_asks_the_gate`](<../../Integration Tests/Authorization Start Limit Explanation.md#a_deciding_browser_s_request_raised_for_the_owner_asks_the_gate>) and [`a_browser_signed_in_as_the_owner_passes_without_asking_the_gate`](<../../Integration Tests/Authorization Start Limit Explanation.md#a_browser_signed_in_as_the_owner_passes_without_asking_the_gate>).

## `issue_under_standing_grant`

**The fast path is the one place a code is issued with no person deciding, and its authority is the standing grant.** It goes through the same writer as the Owner's approval, {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs RequestApprover::approve_for_code}}, naming `CodeAuthority::StandingGrant`, so every code issued here can be found by that name.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs issue_under_standing_grant}}

The two `Result`s say which outcomes keep what the scope wrote:

| Approval              | Answer                                                    | The scope                                        |
| --------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| `Issued`              | `RedirectToClient` with the code                          | commits: the request approved, the code issued   |
| `BrowserSessionEnded` | `access_denied` to the app, saying the browser signed out | commits: the request is denied, and stays denied |
| `RequestNotPending`   | `RequestNotPending`                                       | rolls back                                       |

A browser session that has ended means there is nothing to bound the code by and nothing to revoke later, so the request is denied rather than approved.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::a_fully_covered_registered_request_is_issued_a_code_without_a_human}}

The grant (`patient/*.cruds openid`, for `pat-1`) covers `patient/Patient.r openid`. The browser is sent back with `the-code` and `xyz`. The request is approved for `pat-1`; the request and its code both carry the requesting browser's `sid`; the popup was republished once.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::the_fast_path_denies_a_request_whose_browser_session_is_revoked}}

The request names a `sid` with no stored session. The app hears `access_denied` with the signed-out sentence, the request is denied, no code exists, and the popup was still republished.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::a_launch_bound_patient_the_grant_does_not_name_waits_for_the_owner}}

The launch pins `pat-2` and the grant names `pat-1`, so the fast path doesn't apply. The request waits for the Owner, pending, carrying `pat-2`.

Exercised end to end by [`pre_approved_scopes_skip_consent_on_reauthorize`](<../../Integration Tests/Grant Flows Explanation.md#pre_approved_scopes_skip_consent_on_reauthorize>), [`a_narrower_request_is_pre_approved_by_a_broader_standing_grant`](<../../Integration Tests/Grant Flows Explanation.md#a_narrower_request_is_pre_approved_by_a_broader_standing_grant>), [`a_changed_request_never_takes_the_fast_path`](<../../Integration Tests/Grant Flows Explanation.md#a_changed_request_never_takes_the_fast_path>), [`a_paired_browser_takes_the_fast_path_under_its_own_session_until_it_is_revoked`](<../../Integration Tests/Session Required Explanation.md#a_paired_browser_takes_the_fast_path_under_its_own_session_until_it_is_revoked>) and [`a_fast_pathed_authorize_never_becomes_the_newest_pending_consent`](<../../Integration Tests/OAuth Endpoints Explanation.md#a_fast_pathed_authorize_never_becomes_the_newest_pending_consent>).

## `publish`

What a scope hands back is a `Decided`: the step the browser takes next, or the refusal it is sent away with, and whether the newest pending consent may have changed.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs Decided}}

`next_step` is itself a `Result` because some refusals must keep what the scope wrote: the fast path's denial above, and a Continue's [denial for a disabled client](#refuse_waiting_request). Those commit; then `publish` tells the popup if needed and hands the refusal on.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs CodeAuthorizationStarter::publish}}

**The popup is told only after the commit**, so it never shows a request a rolled-back scope didn't keep. Its unit tests are those of [`decide`](#decide) and [`issue_under_standing_grant`](#issue_under_standing_grant), which count the republishes. Exercised end to end by [`authorize_publishes_the_parked_request_as_the_newest_pending_consent`](<../../Integration Tests/OAuth Endpoints Explanation.md#authorize_publishes_the_parked_request_as_the_newest_pending_consent>).

## `continue_past_session_shortfall`

**The browser on the limited page says to go on, and the request takes the branch the start would have taken had the session held all it asks for.** The code it may earn still carries only what the session holds.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs CodeAuthorizationStarter::continue_past_session_shortfall}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs CodeAuthorizationStarter::continue_in}}

What a Continue does, in its one scope:

- **Refuses without a signing key**, as the start does, leaving the request waiting.
- **Loads the request only if it is still on this browser's limited page** ([`load_unacknowledged_code_request`](<Session Shortfall Explanation.md#load_unacknowledged_code_request>)). Another session's request, one gone on already, decided or expired, is not found, the same as an expired request anywhere else.
- **Ends the request if its app was disabled meanwhile** ([`refuse_waiting_request`](#refuse_waiting_request)).
- **Reads the standing-grant coverage again**: the Owner may have approved or revoked a grant while the browser sat on the page.
- **Doesn't ask the start limit.** The request spent from it when it parked.
- **Parks by acknowledging**: [`acknowledge_session_shortfall`](<../../Domain/Authorization Request Explanation.md#acknowledge_session_shortfall>) gives the request a fresh [`AUTHORIZATION_REQUEST_TTL`](#authorization_request_ttl), the guarded replace makes sure a racing Cancel hasn't won, and the session is recorded as gone on for this app, so its later requests for the app skip the page.
- Whether the request is decided on the consent card or the wait page was recorded at its start, and stands.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::continuing_past_the_shortfall_takes_the_fast_path}}

The standing grant covers the request, so going on issues the code at once. The request is approved and acknowledged. The code carries only `openid`: the stored session holds only `wildflower/launch`, which covers none of the requested resource scopes, and `openid` isn't held access.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::continuing_without_a_standing_grant_raises_for_the_owner}}

With no grant, going on four minutes later raises the request for the Owner on the wait page. Its expiry is now five minutes from the Continue, the popup was told, and it is the newest pending consent. Continue passes a limit that always admits; this test doesn't observe that, the [integration test](<../../Integration Tests/Authorization Start Limit Explanation.md#a_continue_whose_start_was_counted_does_not_ask_the_gate_again>) does.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::a_session_gone_on_for_a_client_skips_the_limited_page_for_it}}

After going on once for `app`, the same session's next request for `app` skips the page, even asking for `patient/Condition.r` too; it waits for the Owner (it steps outside the registration) and is parked already acknowledged. Skipping the page, a request raised for the Owner asks the start limit as usual. Another session, and the same session asking for `other-app`, still stop at the page, and nothing is recorded for `other-app`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::only_the_requesting_session_continues_a_request_still_waiting}}

Another session, and the right session at the expiry, both get not found. The right session in time goes on, and a second Continue is not found.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::continuing_without_a_signing_key_refuses_before_acknowledging}}

With no signing key, Continue fails with `NoActiveSigningKey` and the request is still waiting on its page.

Exercised end to end by [`the_fast_path_stops_at_the_limited_page_then_issues_the_narrowed_code`](<../../Integration Tests/Session Shortfall Explanation.md#the_fast_path_stops_at_the_limited_page_then_issues_the_narrowed_code>), [`without_a_standing_grant_continue_raises_the_request_for_the_owner`](<../../Integration Tests/Session Shortfall Explanation.md#without_a_standing_grant_continue_raises_the_request_for_the_owner>), [`a_session_that_went_on_for_an_app_skips_the_limited_page_for_it`](<../../Integration Tests/Session Shortfall Explanation.md#a_session_that_went_on_for_an_app_skips_the_limited_page_for_it>), [`another_browser_can_neither_read_nor_continue_nor_cancel`](<../../Integration Tests/Session Shortfall Explanation.md#another_browser_can_neither_read_nor_continue_nor_cancel>) and [`a_continue_whose_start_was_counted_does_not_ask_the_gate_again`](<../../Integration Tests/Authorization Start Limit Explanation.md#a_continue_whose_start_was_counted_does_not_ask_the_gate_again>), through the route's {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/session_shortfall.rs handle_session_shortfall_continue}}.

## `refuse_waiting_request`

**An app disabled while its request sat on the limited page ends the request at Continue.** The request is denied with [`deny_on_limited_page`](<../../Domain/Authorization Request Explanation.md#deny_on_limited_page>), the same transition as Cancel, and the app hears `access_denied` with the disabled-client sentence. The denial commits; nothing is republished, as the Owner never saw the request. If a Cancel got there first, the guarded replace writes nothing and the answer is not found.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs refuse_waiting_request}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs tests::continuing_for_a_client_disabled_since_denies_the_request}}

`app` is disabled after its request parks. Continue answers `access_denied`, "The supplied client_id has been disabled.", with the app's `state`; the request is denied and the popup was never told.

Exercised end to end by [`continue_for_an_app_disabled_since_denies_the_request`](<../../Integration Tests/Session Shortfall Explanation.md#continue_for_an_app_disabled_since_denies_the_request>).
