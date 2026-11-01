# Consent Card

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs}}

When the person at the browser **is** the Owner, there's no one to wait for. `/oauth/authorize` sends a browser signed in as the Owner to the consent card, `/oauth/authorize/{id}/consent`, where the request is decided in place. Any other browser with a session goes to the [Wait Page](<Wait Page Explanation.md>), and a browser without one goes to pairing.

The card decides through the same `/authorization/oauth-consents/{id}` API the host's popup uses, on the browser session's own token as its bearer. In the running server the host's cookie-to-bearer layer presents that token for the card; these tests send it as the bearer themselves. Which page a request goes to is recorded on the [`CodeRequest`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest>) as `decidable_in_requesting_browser`, and shown to the host on the [`OwnerPrompt`](<../Domain/Owner Prompt Explanation.md#item-OwnerPrompt>).

This file's own helpers are on the [Test Fixtures](<Test Fixtures Explanation.md#integrationconsent_card>) page, with the shared ones.

## `integration::consent_card`

### `a_browser_signed_in_as_the_owner_goes_to_the_consent_card`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs a_browser_signed_in_as_the_owner_goes_to_the_consent_card}}

Relies on [`BrowserSession::new_same_device_session`](<../Domain/Browser Session Explanation.md#item-BrowserSession--new_same_device_session>) and [`can_decide_consents`](<../HTTP/Browser Session Cookie Explanation.md#item-can_decide_consents>). Fixtures first used here: [`spin_up`](<Test Fixtures Explanation.md#item-spin_up>), [`seed_client_with_redirect`](<Test Fixtures Explanation.md#item-seed_client_with_redirect>), [`signed_in_same_device_session_token`](<Test Fixtures Explanation.md#item-signed_in_same_device_session_token>), [`authorize_with_cookie`](<Test Fixtures Explanation.md#item-authorize_with_cookie>) and [`parked_page`](<Test Fixtures Explanation.md#item-parked_page>).

### `a_browser_without_a_session_goes_to_pairing`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs a_browser_without_a_session_goes_to_pairing}}

Relies on [`carried_browser_session`](<../HTTP/Browser Session Cookie Explanation.md#item-carried_browser_session>), which finds no standing session in any of them. Fixtures first used here: [`revocation_store_handle`](<Test Fixtures Explanation.md#item-revocation_store_handle>), [`location_of`](<Test Fixtures Explanation.md#item-location_of>) and [`owner_prompt`](<Test Fixtures Explanation.md#item-owner_prompt>).

### `a_browser_session_that_cannot_decide_consents_goes_to_the_wait_page`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs a_browser_session_that_cannot_decide_consents_goes_to_the_wait_page}}

Relies on [`OwnerPrompt`](<../Domain/Owner Prompt Explanation.md#item-OwnerPrompt>). Fixtures first used here: [`signed_in_session_token_that_cannot_decide`](<Test Fixtures Explanation.md#item-signed_in_session_token_that_cannot_decide>).

### `the_newest_pending_consent_says_whether_its_browser_can_decide_it`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs the_newest_pending_consent_says_whether_its_browser_can_decide_it}}

Relies on [`OwnerPrompt::for_request`](<../Domain/Owner Prompt Explanation.md#item-OwnerPrompt--for_request>). Fixtures first used here: [`parked_on_the_card`](<Test Fixtures Explanation.md#item-parked_on_the_card>) and [`browser_session_cookie`](<Test Fixtures Explanation.md#item-common--browser_session_cookie>).

### `approving_on_the_owner_s_bearer_sends_the_code_to_the_client_and_settles_the_wait_page`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs approving_on_the_owner_s_bearer_sends_the_code_to_the_client_and_settles_the_wait_page}}

Relies on [`CodeRequest::to_approved`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--to_approved>), through [`ConsentDecider::approve_oauth_consent`](<../Capabilities/Access/OAuth Consents Explanation.md#item-ConsentDecider--approve_oauth_consent>). Fixtures first used here: [`decide`](<Test Fixtures Explanation.md#item-consent_card--decide>), [`body_json`](<Test Fixtures Explanation.md#item-body_json>) and [`status_of`](<Test Fixtures Explanation.md#item-status_of>).

### `a_scope_that_was_not_requested_is_not_granted`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs a_scope_that_was_not_requested_is_not_granted}}

Relies on [`DelegatedScopes::clamp`](<../Authority/Delegated Scopes Explanation.md#item-DelegatedScopes--clamp>), which keeps only ticks the request asked for. Fixtures first used here: [`build_request`](<Test Fixtures Explanation.md#item-build_request>) and [`CODE_VERIFIER`](<Test Fixtures Explanation.md#item-CODE_VERIFIER>).

### `an_unacknowledged_new_registration_is_refused`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs an_unacknowledged_new_registration_is_refused}}

Relies on [`PresentedClientChange::would_change_registration`](<../Domain/Client Explanation.md#item-PresentedClientChange--would_change_registration>), checked by [`ConsentDecider::approve_oauth_consent`](<../Capabilities/Access/OAuth Consents Explanation.md#item-ConsentDecider--approve_oauth_consent>).

### `denying_sends_access_denied_to_the_client_and_settles_the_wait_page`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs denying_sends_access_denied_to_the_client_and_settles_the_wait_page}}

Relies on [`CodeRequest::to_denied`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--to_denied>).

### `the_consent_card_is_locked_down_and_uncached`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs the_consent_card_is_locked_down_and_uncached}}

Relies on [`router`](<../HTTP/Routes/Authorization Pages Explanation.md#item-authorization_pages--router>). Fixtures first used here: [`assert_cache_suppressed`](<Test Fixtures Explanation.md#item-assert_cache_suppressed>).
