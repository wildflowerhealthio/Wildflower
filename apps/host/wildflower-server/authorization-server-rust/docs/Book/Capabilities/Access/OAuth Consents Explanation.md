# OAuth Consents

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/oauth.rs}}

An app has sent a browser to `/oauth/authorize`, and the request is parked, waiting for a decision. This page is that decision, as the consent card and the Owner's popup drive it: read the prompt, ask the Owner about it, approve it, deny it. The capabilities are on [Consents](<Consents Explanation.md>); the request itself is an [authorization request](<../../Domain/Authorization Request Explanation.md>) of the code kind.

Every operation here starts by loading the prompt, and then resolves it against the app's registration as it stands now. **A prompt whose app has been disabled is never read and never approved.**

## `load_pending_code_request`

**A prompt exists for the deciders only while its request is pending, of the code kind, and past its browser's limited page.** A request whose browser holds less than it asked for waits on the [limited page](<../../Domain/Authorization Request Explanation.md#acknowledge_session_shortfall>) until that browser goes on with it, and until then the Owner can't read, approve, deny or be asked about it. Anything else is not found.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/oauth.rs load_pending_code_request}}

It rests on [`into_pending_code`](<../../Domain/Authorization Request Explanation.md#into_pending_code>).

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::load_pending_code_request_accepts_a_live_request_and_refuses_the_rest}}

A live request loads with its code-flow part; an expired one, one still on its limited page, and an unknown id are each `OAuthConsentNotFound`.

## `oauth_consent`

**The consent card's read**: the pending request, the app's display name, its registration verdict against the row as it stands, and the approval scopes the reader lacks. One read scope. A prompt whose app is disabled is not found, as a missing one is.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/oauth.rs ConsentReader::oauth_consent}}

The resolution against the registration is [`ResolvedCodeRequest`](<../../Domain/Client Explanation.md#resolvedcoderequest>), shared with `/oauth/authorize` and the approval below, so the card can't disagree with the endpoint that parked the request.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/oauth.rs resolve}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::consent_reader_oauth_consent_resolves_the_client_name}}

The view carries the pending request, with the redirect it was made at.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::consent_reader_says_which_approval_scopes_the_reader_lacks}}

A reader holding only `wildflower/AuthorizationRequest.r` is told it lacks deciding, creating the grant, and both client scopes (the fixture app has no row, so it is trusted on first use); an Owner lacks nothing.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::consent_reader_surfaces_a_client_read_failure}}

Against the SQLite store, an app row that can't be read fails the read on both surfaces, rather than rendering the app as one the Owner has never seen.

Exercised end to end by [`oauth_consent_prompt_carries_client_display_name`](<../../Integration Tests/Grant Flows Explanation.md#oauth_consent_prompt_carries_client_display_name>), [`consent_prompt_reports_the_registration_verdict`](<../../Integration Tests/Grant Flows Explanation.md#consent_prompt_reports_the_registration_verdict>), [`authorize_treats_a_cross_grammar_scope_request_as_new`](<../../Integration Tests/OAuth Endpoints Explanation.md#authorize_treats_a_cross_grammar_scope_request_as_new>) and [`the_owner_neither_sees_nor_decides_a_request_waiting_on_its_limited_page`](<../../Integration Tests/Session Shortfall Explanation.md#the_owner_neither_sees_nor_decides_a_request_waiting_on_its_limited_page>).

## `raise_for_owner`

**A browser that can read a prompt but not approve it hands it to the Owner.** The request stops counting as decidable in the browser that made it, so the host notifies the Owner. It decides nothing: the request stays pending.

Raising spends from the authorization start limit, as starting a request the Owner is asked about does, so asking about request after request costs what starting them would have. The handler passes the limit in as `may_raise_for_owner`. **A prompt already the Owner's is not raised again and spends nothing.** The order inside the write scope is: load the prompt, refuse a disabled app's, answer `AlreadyRaised` for a prompt not decidable in its browser, ask the limit, then write the [`raise_for_owner`](<../../Domain/Authorization Request Explanation.md#raise_for_owner>) transition. The newest pending consent is republished only when a prompt was raised.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/oauth.rs ConsentRaiser::raise_for_owner}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::raising_a_prompt_for_the_owner_leaves_it_pending_and_republishes}}

A refused limit leaves the prompt decidable where it was made and republishes nothing. An admitted raise clears that, leaves the request pending and republishes once. Raising again answers `AlreadyRaised` without asking the limit, and a denied request is not found.

Exercised end to end by [`asking_the_owner_raises_a_request_decidable_in_the_requesting_browser`](<../../Integration Tests/Approval Scopes Explanation.md#asking_the_owner_raises_a_request_decidable_in_the_requesting_browser>), [`asking_the_owner_is_refused_by_the_limit_and_raises_nothing`](<../../Integration Tests/Authorization Start Limit Explanation.md#asking_the_owner_is_refused_by_the_limit_and_raises_nothing>) and [`asking_the_owner_spends_only_when_it_raises_a_request`](<../../Integration Tests/Authorization Start Limit Explanation.md#asking_the_owner_spends_only_when_it_raises_a_request>).

## `approve_oauth_consent`

**The Owner approves an app's request: the code, the standing grant and, for an app trusted on first use, its registration land together in one write scope, or none of them does.** Once it has committed, the newest pending consent is republished, and the outcome carries the app's callback with the code and the app's `state`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/oauth.rs ConsentDecider::approve_oauth_consent}}

Inside the scope, the prompt is loaded and resolved against the app's registration. An app disabled since the request was made can't be approved, so the request is denied there and then, and the app hears why.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/oauth.rs ConsentDecider::approve_oauth_in from="let pending_request" through="if resolved.client_disabled()"}}

Then the checks, in order. The [`DelegatedScopes`](<../../Authority/Delegated Scopes Explanation.md>) proof comes first, so an approver lacking an approval scope is refused before anything else; it also clamps the ticks to what the prompt may grant and refuses a resource scope the approver doesn't hold. Then the Owner's acknowledgement, when the [registration verdict](<../../Domain/Client Explanation.md#needs_acknowledgement>) calls for one. Then the patient, which must be the launch's when the app's SMART launch bound one ([`admits_patient`](<../../Domain/Authorization Request Explanation.md#admits_patient>)). **Each refusal is an error, so it writes nothing and the prompt stays pending.** Only then does a clamp that left nothing become a deny.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/oauth.rs ConsentDecider::approve_oauth_in from="let maybe_delegated_scopes" through="let Some(delegated_scopes)"}}

Last, the writes, under the proof. The [request approver](<../../Writers/Request Approver Explanation.md>) approves the request and issues the code, bounded by the requesting browser's session; if that session has ended, it denies the request instead, and the app is told the browser signed out. The [grant recorder](<../../Writers/Grant Recorder Explanation.md>) records or widens the standing grant and, for an app trusted on first use, its registration.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/oauth.rs ConsentDecider::approve_oauth_in from="let issued_code" through="Ok(ConsentOutcome::Approved"}}

### What it looks like: the approval lands

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_mints_a_code_and_returns_the_redirect}}

The outcome is the callback with the code and `state`, the code and the grant are stored, and the newest pending consent is republished once.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::an_approver_holding_the_approval_scopes_approves_a_registered_app}}

An approved browser holding every approval scope and the requested resource scope approves.

### What it looks like: a deny instead

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_with_nothing_granted_is_a_deny}}

Ticking only a scope the request didn't ask for grants nothing: the outcome is the callback with `access_denied` and "The request was declined.", the request is denied, and the newest pending consent is republished.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_clamps_a_fixed_registration_to_itself}}

The host app's fixed registration is its own ceiling: a scope outside it is pruned, nothing is left, and the approval is a deny that leaves the row as it was.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::a_prompt_whose_client_was_disabled_is_denied_not_approved}}

Once the app is disabled, the prompt isn't read, and approving it denies it with the disabled-app description: no code, no grant, one republish.

### What it looks like: the approval scopes

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_rejects_a_requested_resource_scope_the_approver_lacks}}

An approver lacking the requested resource scope is refused, naming it; the request stays pending and nothing is republished.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_requires_creating_the_grant}}

Without `wildflower/Grant.c` the approval is refused, naming it: no grant, still pending, no republish.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_requires_both_client_scopes_whatever_the_row}}

For an app trusted on first use, with no row, a row to widen, or a row that already matches, an approver holding one of the two client scopes is refused naming the other, and the row is unchanged.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_with_both_client_scopes_registers_a_new_client}}

With both, the approval registers the new app.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approving_for_a_fixed_registration_takes_no_client_scope}}

The host app's fixed registration is never written, so approving its changed request takes no client scope.

### What it looks like: the registration

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_rejects_an_unacknowledged_new_client}}

An app never seen before, approved without the acknowledgement, is refused: no app row, no grant, and the request still pending.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_registers_an_acknowledged_new_client}}

Acknowledged, the approval registers it: a public client named after its `client_id`, with the one redirect it used, exactly the granted scopes, every grant type, no secret, not disabled.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_widens_a_changed_registration}}

A known app's changed request widens its row in place: the new redirect is appended, and only the granted scopes are added, so a scope the Owner pruned stays out. The name and registration time are kept.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_may_grant_a_scope_outside_the_registration}}

For an app trusted on first use, a requested scope outside the registration can be granted, and it then joins the registration.

### What it looks like: the patient and the missing prompt

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_requires_the_launch_bound_patient}}

When the launch bound `pat-1`, approving for another patient or for none is `LaunchPatientMismatch` and writes nothing; approving for `pat-1` binds it to the code.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_maps_a_missing_request_to_not_found}}

An unknown id is `OAuthConsentNotFound`.

Exercised end to end by [`auth_code_grant_happy_path_end_to_end`](<../../Integration Tests/Grant Flows Explanation.md#auth_code_grant_happy_path_end_to_end>), [`auth_code_grant_owner_narrows_requested_scope`](<../../Integration Tests/Grant Flows Explanation.md#auth_code_grant_owner_narrows_requested_scope>), [`an_approver_lacking_a_requested_resource_scope_is_refused_and_the_request_stays_pending`](<../../Integration Tests/Grant Flows Explanation.md#an_approver_lacking_a_requested_resource_scope_is_refused_and_the_request_stays_pending>), [`approving_a_new_app_without_acknowledgement_is_rejected`](<../../Integration Tests/Grant Flows Explanation.md#approving_a_new_app_without_acknowledgement_is_rejected>), [`approving_a_new_app_registers_it_and_the_next_request_fast_paths`](<../../Integration Tests/Grant Flows Explanation.md#approving_a_new_app_registers_it_and_the_next_request_fast_paths>), [`approving_a_changed_app_widens_its_registration`](<../../Integration Tests/Grant Flows Explanation.md#approving_a_changed_app_widens_its_registration>), [`approving_on_the_owner_s_bearer_sends_the_code_to_the_client_and_settles_the_wait_page`](<../../Integration Tests/Consent Card Explanation.md#approving_on_the_owner_s_bearer_sends_the_code_to_the_client_and_settles_the_wait_page>), [`a_scope_that_was_not_requested_is_not_granted`](<../../Integration Tests/Consent Card Explanation.md#a_scope_that_was_not_requested_is_not_granted>), the [Approval Scopes](<../../Integration Tests/Approval Scopes Explanation.md>) tests, and [`approving_a_request_whose_session_was_revoked_denies_it`](<../../Integration Tests/Browser Sessions Explanation.md#approving_a_request_whose_session_was_revoked_denies_it>).

## `deny_oauth_consent`

**The Owner declines an app's request.** In one write scope the prompt is loaded and [denied](<Consents Explanation.md#deny_pending_request>), the newest pending consent is republished, and the outcome carries the app's callback with `access_denied`, "The request was declined.", and the app's `state`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/oauth.rs ConsentDecider::deny_oauth_consent}}

Every deny on this surface builds its callback the same way, with the description saying why.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/oauth.rs denial_outcome}}

No unit test of its own. Exercised end to end by [`denying_a_new_app_registers_nothing`](<../../Integration Tests/Grant Flows Explanation.md#denying_a_new_app_registers_nothing>), [`denying_sends_access_denied_to_the_client_and_settles_the_wait_page`](<../../Integration Tests/Consent Card Explanation.md#denying_sends_access_denied_to_the_client_and_settles_the_wait_page>) and [`the_pending_consent_watcher_sees_an_older_request_decided_under_a_newer_one`](<../../Integration Tests/OAuth Endpoints Explanation.md#the_pending_consent_watcher_sees_an_older_request_decided_under_a_newer_one>).
