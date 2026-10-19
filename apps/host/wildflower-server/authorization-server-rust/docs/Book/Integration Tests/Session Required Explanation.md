# Session Required

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs}}

An app's request starts in a browser, and the server asks about the browser before it asks about the app. **A browser without a browser session gets nothing from `/oauth/authorize` but a trip to the pairing page**, and it comes back to the same request once paired. A browser with one gets the whole flow. Every code its request earns is issued under **that browser's session**, never the approver's, and carries only what that session also holds.

These tests hold the server to both halves. They lean on the [browser session](<../Domain/Browser Session Explanation.md>), on the [authorization request](<../Domain/Authorization Request Explanation.md>) that records the `sid` it was made in, and on the [launch context](<../Domain/Launch Context Explanation.md>) a SMART launch carries. The browser the app runs in is the harness's paired browser ([`TestDb`](<../Integration Tests Explanation.md#testdb>)), which holds every FHIR scope but can't decide consents. Other browsers come from [`paired_browser_session_holding`](<../Integration Tests Explanation.md#paired_browser_session_holding>) and [`signed_in_owner_session_token`](<../Integration Tests Explanation.md#signed_in_owner_session_token>).

## Helpers

`park_and_approve` makes a request in one browser and approves it as the Owner, which leaves a standing grant behind:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs park_and_approve}}

`pairing_next` reads where the pairing page will send the browser back to, and fails unless the `Location` is the pairing page:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs pairing_next}}

`family_sid` reads, from the store, the browser session a refresh family records:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs family_sid}}

## `a_browser_without_a_session_is_sent_to_pairing_even_with_a_standing_grant`

**No session, no code, even when a standing grant would cover the request.** The FHIR web UI's request and a hosted app's launched request are both sent to `/oauth/pair`, each with a `next` that is exactly the original request. The Owner's newest pending consent doesn't change, and the pairing page accepts each `next`. The launch is left unspent: the paired browser then makes the same launched request and takes the fast path with it.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs a_browser_without_a_session_is_sent_to_pairing_even_with_a_standing_grant}}

Relies on the front door of {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorize.rs handle_authorize_request}}, which redirects before any request is parked or any launch consumed.

## `an_expired_launch_and_an_unknown_one_go_back_to_the_app_saying_why`

**A launch that lapsed goes back to the app as `invalid_request`, telling the person to open the app again.** A launch can lapse while the Owner approves the browser's pairing. A launch the server never minted gets the same error with a different reason: it isn't recognized.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs an_expired_launch_and_an_unknown_one_go_back_to_the_app_saying_why}}

Relies on [`for_client`](<../Domain/Launch Context Explanation.md#for_client>), [`LAUNCH_CONTEXT_TTL`](<../Domain/Launch Context Explanation.md#launch_context_ttl>) and [`LaunchRefusal`](<../Domain/Launch Context Explanation.md#launchrefusal>).

## `the_code_names_the_requesting_browser_s_session_not_the_approver_s`

**The code belongs to the browser that asked.** The paired browser parks the request, and the Owner approves it from a signed-in browser of their own. The paired browser's status poll collects the code. The access token's `sid` and the refresh family's `sid` both name the paired browser's session, not the Owner's.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs the_code_names_the_requesting_browser_s_session_not_the_approver_s}}

Relies on the `sid` of the [code request](<../Domain/Authorization Request Explanation.md#the-code-request>) and on [`approve_code`](<../Domain/Authorization Request Explanation.md#approve_code>), through {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs RequestApprover::approve_for_code}}.

## `an_owner_approval_from_another_browser_is_bounded_by_the_requesting_session`

**The Owner approves what the app asked for, but the code carries only what the requesting browser's session also holds.** A browser paired without `patient/Observation.rs` goes on past the limited page to the wait page. The Owner approves all three scopes, and the code redeems without `patient/Observation.rs`. The Owner's own session, which holds everything, then makes the same request and takes the fast path on that grant with all three.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs an_owner_approval_from_another_browser_is_bounded_by_the_requesting_session}}

Relies on [`acknowledge_session_shortfall`](<../Domain/Authorization Request Explanation.md#acknowledge_session_shortfall>) and {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs session_bounded_scopes}}.

## `a_paired_browser_takes_the_fast_path_under_its_own_session_until_it_is_revoked`

**A standing grant another browser earned doesn't carry a narrower browser past its own bounds, and revoking that browser's session ends what it earned.** The narrow browser stops at the limited page, goes on, and takes the fast path. Its tokens and refresh family name its own session and carry `patient/Patient.rs offline_access`, and a refresh keeps those scopes. Once the session is revoked, the rotated refresh token is `invalid_grant`. The same browser, and a browser with no session, are then sent to pairing.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs a_paired_browser_takes_the_fast_path_under_its_own_session_until_it_is_revoked}}

Relies on [`is_live`](<../Domain/Browser Session Explanation.md#is_live>), the [refresh token family](<../Domain/Refresh Token Explanation.md>) and {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs session_bounded_scopes}}.

## `a_leaked_request_id_collects_nothing`

**The status poll answers the browser that parked the request, not whoever holds its id.** Another paired browser, and a browser without a session, get the same `404` and error as an id that doesn't exist. The requesting browser still reads `approved`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs a_leaked_request_id_collects_nothing}}

Relies on the `sid` of the [code request](<../Domain/Authorization Request Explanation.md#the-code-request>), which {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs AuthorizationStatusReader::status}} compares with the polling browser's.

## `the_wait_page_reads_the_status_after_the_owner_signs_in_in_the_same_browser`

**When the Owner signs in through `/oauth/sign-in` in the browser whose wait page is polling, the poll still answers.** The sign-in hands that browser a new session, with a different `sid`, whose grant can read and update authorization requests. The poll answers it with the approved redirect, and the code still names the session the request was made in. A signed-in session that can read requests but not update them gets the `404` an unknown id gets, and so does no session.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs the_wait_page_reads_the_status_after_the_owner_signs_in_in_the_same_browser}}

Relies on [`new_owner`](<../Domain/Browser Session Explanation.md#new_owner>) and {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/authorization_status_reader.rs any_request_status_scopes}}, the scopes that let a session read a request made in another.
