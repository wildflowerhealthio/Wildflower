# OAuth Consents

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/oauth.rs}}

An app has sent a browser to `/oauth/authorize`, and its [code request](<../../Domain/Authorization Request/Code Request Explanation.md>) is parked, waiting for a decision. This page is that decision, as the consent card and the Owner's popup drive it: read the prompt, ask the Owner about it, approve it, deny it. The capabilities are declared on [Consents](<Consents Explanation.md>).

Every operation starts by loading the prompt, and then resolves it against the app's [registration](<../../Domain/Client Explanation.md>) as it stands now, through the same [`ResolvedCodeRequest`](<../../Domain/Authorization Request/Code Request Explanation.md#item-ResolvedCodeRequest>) `/oauth/authorize` used to park it, so the card can't disagree with the endpoint. **A prompt whose app has been disabled is never read and never approved**: reading it is not found, and approving it denies it.

An approval writes through the writers, inside the decider's one write scope: the [request approver](<../../Writers/Request Approver Explanation.md>) issues the code, bounded by the browser session the request was made in, and the [grant recorder](<../../Writers/Grant Recorder Explanation.md>) records the standing grant and, for an app trusted on first use, its registration. So the code, the grant and the registration land together or not at all.

The tests decide through a decider built over the [consent fixtures](<../Test Fixtures Explanation.md#consents>).

## `domain::capabilities::access::consents::oauth`

### `load_pending_code_request`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/oauth.rs load_pending_code_request}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::load_pending_code_request_accepts_a_live_request_and_refuses_the_rest}}

### `resolve`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/oauth.rs resolve}}

### `ConsentReader`

#### `oauth_consent`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/oauth.rs ConsentReader::oauth_consent}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::consent_reader_oauth_consent_resolves_the_client_name}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::consent_reader_says_which_approval_scopes_the_reader_lacks}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::consent_reader_surfaces_a_client_read_failure}}

### `ConsentRaiser`

#### `raise_for_owner`

**A browser that can read a prompt but not approve it hands it to the Owner.** The request's own [`to_raised_for_owner`](<../../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--to_raised_for_owner>) transition is written through the guarded replace, so a request decided meanwhile is not found.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/oauth.rs ConsentRaiser::raise_for_owner}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::raising_a_prompt_for_the_owner_leaves_it_pending_and_republishes}}

### `ConsentDecider`

#### `approve_oauth_consent`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/oauth.rs ConsentDecider::approve_oauth_consent}}

The approval lands:

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_mints_a_code_and_returns_the_redirect}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::an_approver_holding_the_approval_scopes_approves_a_registered_app}}

A deny instead:

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_with_nothing_granted_is_a_deny}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_clamps_a_fixed_registration_to_itself}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::a_prompt_whose_client_was_disabled_is_denied_not_approved}}

The approval scopes:

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_rejects_a_requested_resource_scope_the_approver_lacks}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_requires_creating_the_grant}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_requires_both_client_scopes_whatever_the_row}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_with_both_client_scopes_registers_a_new_client}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approving_for_a_fixed_registration_takes_no_client_scope}}

The registration:

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_rejects_an_unacknowledged_new_client}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_registers_an_acknowledged_new_client}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_widens_a_changed_registration}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_may_grant_a_scope_outside_the_registration}}

The launch's patient, and a prompt that isn't there:

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_requires_the_launch_bound_patient}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_oauth_consent_maps_a_missing_request_to_not_found}}

#### `approve_oauth_in`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/oauth.rs ConsentDecider::approve_oauth_in}}

#### `deny_oauth_consent`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/oauth.rs ConsentDecider::deny_oauth_consent}}

### `deny_pending_request`

The deny is the request's own [`to_denied`](<../../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--to_denied>) transition, written through the [guarded replace](<../../Domain/Authorization Request Explanation.md#transitions-and-the-guarded-replace>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/oauth.rs deny_pending_request}}

### `denial_outcome`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/oauth.rs denial_outcome}}
