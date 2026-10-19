# Request Approver

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs}}

The request approver moves a pending [authorization request](<../Domain/Authorization Request Explanation.md>) to approved, through the request's own transition for its kind ([`approve_code`](<../Domain/Authorization Request Explanation.md#approve_code>), [`approve_device`](<../Domain/Authorization Request Explanation.md#approve_device>), [`approve_pairing`](<../Domain/Authorization Request Explanation.md#approve_pairing>)) written with the [guarded replace](<../Domain/Authorization Request Explanation.md#the-guarded-replace-first-decision-wins>). For the code flow it also issues the [authorization code](<../Domain/Authorization Code Explanation.md>) the app redeems at `/oauth/token`.

**The scopes a request records are exactly the proof's**, never a list the flow put together. A device request and a browser pairing are approved on a [`DelegatedScopes`](<../Authority/Delegated Scopes Explanation.md#delegatedscopes>): the Owner's ticks, clamped to what the approver may delegate. A code request may also be approved with no one at the prompt, on a standing grant that already covers it, so it takes either of two proofs. **A code carries the proof's scopes bounded by the browser session the request was made in.**

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs RequestApprover}}

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs RequestApprover::within}}

`within` builds the approver over the caller's open scope.

## `CodeAuthority`

On whose authority a code request is approved. **Asking "who can issue a code with no human?" finds one answer, by name: `StandingGrant`.** The set is an enum rather than a trait so the list is closed and read in one place.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs CodeAuthority}}

The Owner's approval authorizes the scopes it delegates; a standing grant authorizes the requested scopes it [covers](<../Authority/Standing Grant Explanation.md#standinggrantcoverage>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs CodeAuthority::authorized_scopes}}

## `CodeApproval`

What approving a code request came to. Besides a code, two outcomes issue nothing: the request was decided or expired since it was read, or the browser it was made in has signed out, in which case the request is denied instead.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs CodeApproval}}

## Test fixtures

`pending_code_request` stores a pending code request asking for `read`, made in an Owner session that stands, and hands it over as the approver takes it. `pending_code_request_in_session` does the same in a browser session the test chooses:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs tests::pending_code_request}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs tests::pending_code_request_in_session}}

`stored` reads a request back. `approve` approves a code request on the Owner's authority for `patient/Patient.r`, issuing `the-code`:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs tests::stored}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs tests::approve}}

## `approve_for_code`

The code request is approved under `authority`, and a code issued for it. The code is bound to the request's app, redirect and PKCE challenge, to the patient the approver chose (if any), and to **the browser session the request was made in, not the approver's**: the Owner may approve from another browser, but revoking the browser the app runs in still ends what the code starts. It expires [`AUTHORIZATION_CODE_TTL`](<../Domain/Authorization Code Explanation.md#authorization_code_ttl>) after `now`. The caller generates the code, so a test can name it.

First the request's browser session is read. **A request whose session is no longer live (revoked, expired, or gone) is denied rather than approved**, and the app hears `access_denied`; no code exists that no live session bounds. A request that is no longer pending, at either write, issues nothing.

The request records the authority's scopes. The code carries only those the request's browser session also holds ([`session_bounded_scopes`](<../Authority/Delegated Scopes Explanation.md#session_bounded_scopes>)), so a browser paired with less than the Owner holds earns an app no more than it holds, whoever approved.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs RequestApprover::approve_for_code}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs tests::approve_for_code_records_the_proofs_scopes_on_request_and_code}}

The issued code is bound to the request's app, redirect, challenge and session, with the proof's scopes and the patient, and expires a code lifetime later. The stored request is approved with the same scopes and patient, and the code is stored against it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs tests::approve_for_code_issues_nothing_when_the_request_is_no_longer_pending}}

A request denied after it was read approves to `RequestNotPending`, and no code is stored for it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs tests::approve_for_code_denies_a_request_whose_browser_session_has_ended}}

Requests made in a revoked session, an expired one and one never stored are each denied, with no code. A request made in the standing session gets a code naming that session.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs tests::approve_for_code_bounds_the_code_by_the_request_s_browser_session}}

The Owner approves `openid`, `patient/Patient.read` and `patient/Observation.rs` for a request made in a browser paired with `patient/Patient.rs`. The code carries `openid`, which no one needs to hold, and `patient/Patient.read`, which the session holds in its other spelling; `patient/Observation.rs` is dropped. The request records all three.

Exercised end to end by [`the_code_names_the_requesting_browser_s_session_not_the_approver_s`](<../Integration Tests/Session Required Explanation.md#the_code_names_the_requesting_browser_s_session_not_the_approver_s>), [`an_owner_approval_from_another_browser_is_bounded_by_the_requesting_session`](<../Integration Tests/Session Required Explanation.md#an_owner_approval_from_another_browser_is_bounded_by_the_requesting_session>), [`approving_a_request_whose_session_was_revoked_denies_it`](<../Integration Tests/Browser Sessions Explanation.md#approving_a_request_whose_session_was_revoked_denies_it>) and [`pre_approved_scopes_skip_consent_on_reauthorize`](<../Integration Tests/Grant Flows Explanation.md#pre_approved_scopes_skip_consent_on_reauthorize>).

## `approve_for_device`

A device request, as it was read, is approved under the Owner's delegated scopes, binding the patient (if any) and recording the device's name. The approver may rename the device; `None` keeps the name the device gave. It answers `false`, having changed nothing, when the request was no longer pending.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs RequestApprover::approve_for_device}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs tests::approve_for_device_records_scopes_and_name_only_while_pending}}

The request is approved under the approver's name for the device. Approving the same read again answers `false`.

Exercised end to end by [`device_consent_threads_patient_onto_request`](<../Integration Tests/Device Code Explanation.md#device_consent_threads_patient_onto_request>) and [`device_consent_approver_can_adjust_device_name`](<../Integration Tests/Device Code Explanation.md#device_consent_approver_can_adjust_device_name>).

## `approve_browser_pairing`

A browser pairing, as it was read, is approved under the Owner's delegated scopes, recording the browser's name (the approver's rename, or `None` to keep the browser's own). A pairing binds no patient. **The approval starts no session.** The approved session is started later, when the pairing page's poll [claims](<../Authority/Browser Pairing Explanation.md#claim>) the request. It answers `false`, having changed nothing, when the request was no longer pending.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs RequestApprover::approve_browser_pairing}}

No unit test of its own. Exercised end to end by [`a_browser_pairs_and_holds_a_day_long_session_with_the_approved_scopes`](<../Integration Tests/Browser Pairing Explanation.md#a_browser_pairs_and_holds_a_day_long_session_with_the_approved_scopes>).
