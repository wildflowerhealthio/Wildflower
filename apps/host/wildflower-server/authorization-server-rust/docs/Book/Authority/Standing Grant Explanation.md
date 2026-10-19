# Standing Grant

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs}}

Once the Owner has approved an app, its next request for the same thing shouldn't ask again. A [standing grant](<../Domain/Grant Explanation.md>) records what the Owner approved for an app at one redirect, and `/oauth/authorize` may issue a code on it **with nobody asked**: OAuth permits skipping consent on a prior decision. That fast path is a code issued with no human in the loop, so it needs a proof of its own.

**A standing grant authorizes a request only when it covers every scope the request asks for, and the request is inside the app's registration.** However well an old grant covers a request from a new app, at a new redirect or for a new scope, the Owner hasn't seen that combination, so it goes back to them. A grant that covers only some of the scopes isn't a proof, but the Owner's earlier yes still counts: the consent card opens with those scopes already ticked.

## `GrantCoverage`

How far a standing grant covers a request. Only `Full` is a proof; the other two carry what the consent card pre-ticks.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs GrantCoverage keep-docs}}

## `StandingGrantCoverage`

The proof. It carries the request's scopes, as the request spells them, and the grant's patient context, so the code issued under it binds the patient the Owner chose at approval.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs StandingGrantCoverage}}

Its two getters, `covered_scopes` and `patient`, are what the request approver's [`approve_for_code`](<../Writers/Request Approver Explanation.md#approve_for_code>) issues the code with, through its `CodeAuthority::StandingGrant`. `/oauth/authorize` takes the fast path on a proof only when the request also [admits](<../Domain/Authorization Request Explanation.md#admits_patient>) the grant's patient, so a request whose launch bound a different patient is asked about instead. The code is still bounded by the browser session, in [`session_bounded_scopes`](<Delegated Scopes Explanation.md#session_bounded_scopes>).

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs StandingGrantCoverage::covered_scopes StandingGrantCoverage::patient}}

## Test fixtures

Every test presents its request at the one redirect `https://example.com/cb`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs tests::redirect}}

`store_with_grant` stores one standing grant for the app `client` at that redirect, with the scopes and patient the test passes, over the shared [`code_grant`](<../Grant Store/Test Fake Explanation.md#code_grant>) fixture.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs tests::store_with_grant}}

## `resolve`

The one constructor, and the rule. A request whose [registration verdict](<../Domain/Client Explanation.md#is_registered>) isn't `Registered` is `Uncovered`, whatever the grant says. Otherwise the grant for the app and redirect is looked up; with none, `Uncovered`. With one, each requested scope is kept if some granted scope covers it. All kept is `Full`; some is `Partial`.

**Covers means permission, not spelling.** A standing grant is a set of permissions, so `patient/*.cruds` answers for a later `patient/Observation.r`, and a grant an approval recorded as `.rs` still answers for a request for `.r` or `.s` alone.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs GrantCoverage::resolve}}

`/oauth/authorize` resolves it in the scope that parks the request, after the registration verdict, and again when the browser goes on past the limited page.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs tests::full_coverage_is_a_proof_carrying_the_requested_scopes}}

A grant of `patient/*.cruds openid` fully covers a request for `patient/Observation.r openid`; the proof carries the request's scopes as asked, and the grant's patient.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs tests::unregistered_requests_and_missing_grants_never_prove}}

The same grant doesn't cover a `New` request at all, and an app with no grant is `Uncovered` too.

Exercised end to end by [`pre_approved_scopes_skip_consent_on_reauthorize`](<../Integration Tests/Grant Flows Explanation.md#pre_approved_scopes_skip_consent_on_reauthorize>), [`a_narrower_request_is_pre_approved_by_a_broader_standing_grant`](<../Integration Tests/Grant Flows Explanation.md#a_narrower_request_is_pre_approved_by_a_broader_standing_grant>) and [`a_changed_request_never_takes_the_fast_path`](<../Integration Tests/Grant Flows Explanation.md#a_changed_request_never_takes_the_fast_path>).

## `pre_approved_scopes`

The requested scopes the grant already covers, which a parked request records as its pre-approved scopes, for the consent card to open with ticked. Nothing for `Uncovered`; everything for `Full`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs GrantCoverage::pre_approved_scopes}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs tests::partial_coverage_pre_ticks_without_proving}}

A grant of `openid` alone is `Partial` for a request that also asks for `patient/Observation.r`, and pre-ticks `openid`.
