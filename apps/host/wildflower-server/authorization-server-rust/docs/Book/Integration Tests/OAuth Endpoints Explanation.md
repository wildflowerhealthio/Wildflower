# OAuth Endpoints

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs}}

These tests hold the server's three OAuth doors to their contract with apps: `/oauth/authorize`, where a browser starts an app's request, `/oauth/device_authorization`, where a device starts one, and `/oauth/token`, where an app collects what it was granted. They are about what each door accepts, refuses and reports, more than about what happens once the Owner decides; [Grant Flows](<Grant Flows Explanation.md>) follows the flows end to end.

Most of the file is `/oauth/authorize`, and most of that is one rule from RFC 6749: **an error may be sent back to an app's redirect only once that redirect is trusted.** A redirect is trusted when a client the server already knows has it registered. Until then, a failure renders a local error page, because redirecting to an address nobody vouched for would be an open redirect. Clients without a server-defined registration are trusted on first use: an unknown client, a new redirect or a new scope is carried to the Owner's prompt instead of refused. The client's registration and how a request compares against it are on [the Client page](<../Domain/Client Explanation.md>).

The tests run in this order: what `/oauth/authorize` checks and how it fails, a request's scopes against its client's registration, SMART App Launch, telling the Owner about a parked request, the device door, and the token door. All of them start from [`spin_up`](<../Integration Tests Explanation.md#spin_up>) and drive the router with the helpers on [the Integration Tests page](<../Integration Tests Explanation.md>).

## Helpers

The SMART launch tests build their queries with one local helper, and two of them expect the same refusal.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs smart_launch_query}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs ALREADY_USED_LOCATION}}

## `authorize_unknown_client_parks_a_pending_request`

**A `client_id` the server has never seen is not turned away, and it leaves no trace until the Owner approves.** The request parks on the wait page, its status reads `pending`, and nothing is written to the clients table.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_unknown_client_parks_a_pending_request}}

Relies on [`resolve`](<../Domain/Client Explanation.md#resolve>) and [`new`](<../Domain/Authorization Request Explanation.md#new>); drives [`get_authorize`](<../Integration Tests Explanation.md#get_authorize>), [`parked_request_id`](<../Integration Tests Explanation.md#parked_request_id>) and [`get_authorization_status`](<../Integration Tests Explanation.md#get_authorization_status>).

## `authorize_unknown_client_renders_later_failures_locally`

**An unknown client's redirect is untrusted, so every later failure renders locally.** A malformed PKCE challenge, a PKCE method other than S256 and a `response_type` other than `code` each answer `400` with the local page, not a redirect.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_unknown_client_renders_later_failures_locally}}

Relies on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs start_error}}, which picks between the local page and the redirect.

## `authorize_unregistered_redirect_parks_and_keeps_the_redirect_untrusted`

**A known client presenting a redirect it never registered gets the same treatment as an unknown one.** The request parks for the Owner, and the redirect stays untrusted, so a bad PKCE challenge on it renders locally.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_unregistered_redirect_parks_and_keeps_the_redirect_untrusted}}

Relies on [`allows_redirect_uri`](<../Domain/Client Explanation.md#allows_redirect_uri>) and [`seed_client_with_redirect`](<../Integration Tests Explanation.md#seed_client_with_redirect>).

## `authorize_disabled_client_is_still_rejected`

**A disabled client is refused at `/oauth/authorize`: trust on first use doesn't relax it.** The client is written disabled from the start, and its request answers `400` with the "Disabled client" page.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_disabled_client_is_still_rejected}}

Relies on [`Client`](<../Domain/Client Explanation.md#client>) (`disabled_at`) and [`resolve`](<../Domain/Client Explanation.md#resolve>).

## `authorize_validates_redirect_uri_before_pkce_method`

**For a server-defined registration, the redirect is checked before anything that could be sent back to it.** The host app's client has a fixed registration with no redirects, so a request for it fails on the redirect ("Redirect URI not allowed", rendered locally) even though its PKCE method is also wrong.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_validates_redirect_uri_before_pkce_method}}

Relies on [`registration_is_fixed`](<../Domain/Client Explanation.md#registration_is_fixed>).

## `authorize_unsupported_response_type_redirects_back`

**Once the redirect is trusted, an unsupported `response_type` goes back to the app.** The `302` carries `error=unsupported_response_type`, a sentence for the person, and the app's `state`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_unsupported_response_type_redirects_back}}

Relies on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs validate_code_params}}.

## `authorize_unsupported_pkce_method_redirects_invalid_request`

**Once the redirect is trusted, a PKCE method other than S256 goes back to the app as `invalid_request`,** with the app's `state`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_unsupported_pkce_method_redirects_invalid_request}}

Relies on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs validate_code_params}}.

## `authorize_disallowed_scope_parks_a_pending_request`

**A scope outside a client's registration is the Owner's call, not a refusal.** The request parks, and the Owner's prompt marks the registration `changed`, naming exactly the scope that stepped outside it (`write`) and saying the redirect is not new.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_disallowed_scope_parks_a_pending_request}}

Relies on [`resolve`](<../Domain/Client Explanation.md#resolve>) and [`uncovered_scopes`](<../Domain/Client Explanation.md#uncovered_scopes>); reads the prompt with [`get_oauth_consent`](<../Integration Tests Explanation.md#get_oauth_consent>).

## `authorize_host_app_disallowed_scope_still_redirects_invalid_scope`

**The host app's client is not trusted on first use: a scope outside its registration is refused.** With a redirect added so the request gets that far, an unregistered scope goes back to the redirect as `invalid_scope`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_host_app_disallowed_scope_still_redirects_invalid_scope}}

Relies on [`registration_is_fixed`](<../Domain/Client Explanation.md#registration_is_fixed>).

## `authorize_allows_scope_covered_by_a_broader_allowed_scope`

**A registered scope covers the narrower scopes inside it.** A client allowed `patient/Observation.rs` asking for `patient/Observation.r` parks like any allowed request, with no `error=` redirect.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_allows_scope_covered_by_a_broader_allowed_scope}}

Relies on [`uncovered_scopes`](<../Domain/Client Explanation.md#uncovered_scopes>).

## `authorize_treats_a_cross_grammar_scope_request_as_new`

**Coverage never crosses SMART's two scope grammars.** A client registered for the v1 `patient/Observation.read` asking for the v2 `patient/Observation.rs` is asking for something new: the request parks, and the Owner's prompt names `patient/Observation.rs` as a new scope.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_treats_a_cross_grammar_scope_request_as_new}}

Relies on [`uncovered_scopes`](<../Domain/Client Explanation.md#uncovered_scopes>).

## `authorize_consumes_a_smart_launch_once`

**A SMART launch works once.** A `launch` minted for the client, with the server's own origin as `aud`, parks a request that carries the launch (and, since this launch binds none, no patient). The Owner can approve it. The same `launch` presented again is sent back to the app as already used.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_consumes_a_smart_launch_once}}

Relies on [`for_client`](<../Domain/Launch Context Explanation.md#for_client>), {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/launch_contexts.rs consume_launch}} and [`approve_oauth_consent`](<../Integration Tests Explanation.md#approve_oauth_consent>).

## `authorize_consumes_a_launch_for_any_client_once`

**A launch minted for any client is spent by the first client that presents it.** The parked request carries it, and a second presentation is sent back to the app as already used.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_consumes_a_launch_for_any_client_once}}

Relies on [`for_any_client`](<../Domain/Launch Context Explanation.md#for_any_client>) and [`admits_client`](<../Domain/Launch Context Explanation.md#admits_client>).

## `authorize_refuses_a_bad_smart_launch_or_aud`

**A launch the app may not use, or an audience that isn't this server, is `invalid_request` back to the app.** A forged `launch` and one minted for another client read the same ("isn't recognized"), so the app learns nothing about another app's launch. An `aud` naming another server is "a different server". A request with neither parameter, or with this server's origin as `aud`, parks as plain OAuth.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_refuses_a_bad_smart_launch_or_aud}}

Relies on [`LaunchRefusal`](<../Domain/Launch Context Explanation.md#launchrefusal>) and {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs launch_refusal_kind}}.

## `authorize_renders_a_bad_smart_launch_locally_for_an_untrusted_redirect`

**The same refusals render locally while the redirect is untrusted.** For an unknown client, a forged `launch` shows "Launch not recognized" and a foreign `aud` shows "Wrong server", each as a `400` page.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_renders_a_bad_smart_launch_locally_for_an_untrusted_redirect}}

Relies on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs start_error}}.

## `authorize_publishes_the_parked_request_as_the_newest_pending_consent`

**A request parked on the wait page reaches the host, not only the wait page.** The wait page tells its viewer to approve on their device, so the request must become the newest pending consent, named for its client. Otherwise the Owner is never notified and the browser waits until the request expires.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_publishes_the_parked_request_as_the_newest_pending_consent}}

Relies on [the newest pending consent](<../Domain/Pending Consent Explanation.md>) and [`for_request`](<../Domain/Pending Consent Explanation.md#for_request>); reads it with [`newest_pending_consent`](<../Integration Tests Explanation.md#newest_pending_consent>).

## `deciding_an_oauth_consent_clears_the_newest_pending_consent`

**Once the Owner decides a request, the host stops asking about it.** Approving and denying take different paths, so the test runs each: either way the newest pending consent goes back to none.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs deciding_an_oauth_consent_clears_the_newest_pending_consent}}

Relies on [`approve_code`](<../Domain/Authorization Request Explanation.md#approve_code>) and [`deny`](<../Domain/Authorization Request Explanation.md#deny>).

## `the_pending_consent_watcher_sees_an_older_request_decided_under_a_newer_one`

**The host sees a request settle even when it isn't the newest.** Two requests park; the host waits on the older one. Denying it leaves the newer one as the newest pending consent, so nothing reaches the host through that channel, yet the watcher still sees the older request settle.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs the_pending_consent_watcher_sees_an_older_request_decided_under_a_newer_one}}

Relies on [`is_pending_in`](<../Domain/Pending Consent Explanation.md#is_pending_in>) and {{#code-link apps/host/wildflower-server/authorization-server-rust/src/live_bindings/oauth.rs PendingConsentWatcher::until_settled}}, which rereads the request each time the newest pending consent is recomputed, whether or not it changed.

## `a_fast_pathed_authorize_never_becomes_the_newest_pending_consent`

**A request a standing grant already covers never asks the Owner.** After one approval establishes the grant, a second identical request is issued a code inside `/oauth/authorize` and sent straight back to the app, and at no point is it the newest pending consent.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs a_fast_pathed_authorize_never_becomes_the_newest_pending_consent}}

Relies on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs GrantCoverage::resolve}} and [`approve_code`](<../Domain/Authorization Request Explanation.md#approve_code>); sets up with [`authorize_and_approve`](<../Integration Tests Explanation.md#authorize_and_approve>).

## `device_authorization_happy_path`

**A device that asks gets the RFC 8628 response, pointing at this server's device page.** The whole body is pinned: the random `device_code` and `user_code` threaded through, the verification URI on the server's origin with and without the user code, a five-minute expiry and a five-second poll interval. The user code is also one a person can type.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs device_authorization_happy_path}}

Relies on [`new`](<../Domain/Authorization Request Explanation.md#new>) and {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs DeviceAuthorizer::start}}; registers the client with [`seed_test_client`](<../Integration Tests Explanation.md#seed_test_client>).

## `device_authorization_allows_scope_covered_by_client_wildcard`

**A device's scopes are checked by coverage too.** The test client is allowed `system/*.cruds`, so a request for `system/Observation.rs` is issued codes.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs device_authorization_allows_scope_covered_by_client_wildcard}}

Relies on [`allows_scopes`](<../Domain/Client Explanation.md#allows_scopes>).

## `device_authorization_unknown_client_returns_401`

**The device door does not trust on first use: an unknown client is `401 invalid_client`.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs device_authorization_unknown_client_returns_401}}

Relies on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/authenticated_client.rs AuthenticatedClient::authenticate}}.

## `token_exchange_unknown_code_returns_400_invalid_grant`

**A code the server doesn't hold is `invalid_grant`,** not a malformed request.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs token_exchange_unknown_code_returns_400_invalid_grant}}

Relies on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs RedeemedAuthorizationCode::redeem}}.

## `token_exchange_short_code_verifier_returns_400_invalid_grant`

**A PKCE verifier shorter than RFC 7636 allows is refused before the code is looked up,** as `invalid_grant` with "Invalid code_verifier parameter".

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs token_exchange_short_code_verifier_returns_400_invalid_grant}}

Relies on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs RedeemedAuthorizationCode::redeem}}.

## `token_exchange_error_sets_cache_suppression_headers`

**Every `/oauth/token` response is kept out of caches, errors included:** `Cache-Control: no-store` and `Pragma: no-cache` on a refused exchange.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs token_exchange_error_sets_cache_suppression_headers}}

[Cache Suppression](<Cache Suppression Explanation.md>) holds every other response to the same rule.

## `token_exchange_rejects_non_form_content_type`

**The token door takes only a form-encoded body.** A JSON `Content-Type` is `400 invalid_request` before any grant work, and the refusal is still cache-suppressed.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs token_exchange_rejects_non_form_content_type}}

Relies on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_request.rs require_form_urlencoded_content_type}}.

## `token_exchange_unknown_device_code_returns_400_invalid_grant`

**A device-code exchange reaches the device-code lookup.** The grant type arrives as the percent-encoded RFC 8628 URN, and an unknown `device_code` is `invalid_grant` with "Unknown device_code". A parse failure would have answered "Malformed payload" instead.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs token_exchange_unknown_device_code_returns_400_invalid_grant}}

Relies on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ConsumedDeviceRequest::consume}}.
