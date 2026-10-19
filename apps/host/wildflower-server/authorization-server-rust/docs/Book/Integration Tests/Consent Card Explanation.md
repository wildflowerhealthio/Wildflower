# Consent Card

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs}}

When the person at the browser **is** the Owner, there's no one to wait for. `/oauth/authorize` sends a browser signed in as the Owner to the consent card, `/oauth/authorize/{id}/consent`, where the request is decided in place. Any other browser with a session goes to the wait page, and a browser without one goes to pairing.

The card decides through the same `/authorization/oauth-consents/{id}` API the host's popup uses, on the browser session's own token as its bearer. In the running server the host's cookie-to-bearer layer presents that token for the card; these tests send it as the bearer themselves.

Which page a request goes to is recorded on it as `decidable_in_requesting_browser`, on the [code request](<../Domain/Authorization Request Explanation.md#the-code-request>), and shown to the host through [`NewestPendingConsent`](<../Domain/Pending Consent Explanation.md>). Signed-in browsers come from the harness's [`signed_in_owner_session_token`](<../Integration Tests Explanation.md#signed_in_owner_session_token>) and [`signed_in_session_token_that_cannot_decide`](<../Integration Tests Explanation.md#signed_in_session_token_that_cannot_decide>).

## Helpers

`parked_page` reads the page a parked request's `Location` names (`consent` or `wait`) and the request id before it:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs parked_page}}

`parked_on_the_card` signs a browser in as the Owner and parks a request from it, checking it lands on the card:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs parked_on_the_card}}

## `a_browser_signed_in_as_the_owner_goes_to_the_consent_card`

**A browser whose session cookie holds the Owner's session goes to the consent card**, whether the session cookie is alone or among other cookies.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs a_browser_signed_in_as_the_owner_goes_to_the_consent_card}}

Relies on [`new_owner`](<../Domain/Browser Session Explanation.md#new_owner>) and {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs can_decide_consents}}.

## `a_browser_session_that_cannot_decide_consents_goes_to_the_wait_page`

**A session that can read requests but not update them can't decide on a card, so its request goes to the wait page and is raised for the Owner.** The newest pending consent names the request, with `decidable_in_requesting_browser: false`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs a_browser_session_that_cannot_decide_consents_goes_to_the_wait_page}}

Relies on [`NewestPendingConsent`](<../Domain/Pending Consent Explanation.md>).

## `a_browser_without_a_session_goes_to_pairing`

**Anything short of a standing browser session is no session.** No cookie, an unrelated cookie, a cookie that isn't a token, a token whose subject has been revoked, and a good token under another cookie name all go to the pairing page. Nothing is parked.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs a_browser_without_a_session_goes_to_pairing}}

Relies on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/browser_session_cookie.rs carried_browser_session}}, which finds no standing session in any of them.

## `the_newest_pending_consent_says_whether_its_browser_can_decide_it`

**The host learns whether the requesting browser can decide the request itself**, so it knows whether to interrupt the Owner. A request from the Owner's browser is pending with `decidable_in_requesting_browser: true`. One from the paired browser, which goes to the wait page, is pending with `false`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs the_newest_pending_consent_says_whether_its_browser_can_decide_it}}

Relies on [`for_request`](<../Domain/Pending Consent Explanation.md#for_request>).

## `approving_on_the_owner_s_bearer_sends_the_code_to_the_client_and_settles_the_wait_page`

**Approving on the card sends the browser to the app's redirect with a code and the app's `state`.** A wait page left open on the same request settles on the same callback.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs approving_on_the_owner_s_bearer_sends_the_code_to_the_client_and_settles_the_wait_page}}

Relies on [`approve_code`](<../Domain/Authorization Request Explanation.md#approve_code>), through {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/oauth.rs ConsentDecider::approve_oauth_consent}}.

## `a_scope_that_was_not_requested_is_not_granted`

**An approval can't add scopes the app didn't ask for.** The card never offers one; a hand-made approval that ticks `patient/Condition.rs` is still approved, but the token carries only `patient/Observation.rs`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs a_scope_that_was_not_requested_is_not_granted}}

Relies on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs DelegatedScopes::clamp}}, which keeps only ticks the request asked for.

## `an_unacknowledged_new_registration_is_refused`

**An app the server has never seen is approved only once the Owner acknowledges registering it.** `test-app` is registered nowhere here. An approval without `acknowledgedRegistration` is a `409` `RegistrationNotAcknowledged`, and the request stays pending.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs an_unacknowledged_new_registration_is_refused}}

Relies on [`needs_acknowledgement`](<../Domain/Client Explanation.md#needs_acknowledgement>), checked by {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/oauth.rs ConsentDecider::approve_oauth_consent}}.

## `denying_sends_access_denied_to_the_client_and_settles_the_wait_page`

**Denying on the card sends the browser to the app's redirect with `access_denied`.** A wait page left open on the request settles on the same callback.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs denying_sends_access_denied_to_the_client_and_settles_the_wait_page}}

Relies on [`deny`](<../Domain/Authorization Request Explanation.md#deny>).

## `the_consent_card_is_locked_down_and_uncached`

**The card is served on the request's own path, as HTML under a strict content security policy, and never cached.** Its scripts, styles, fonts and connections come only from this origin. Its forms may submit only here and to the launcher's origin, since its sign-out form posts here and is redirected on to the launcher. It can't be framed.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs the_consent_card_is_locked_down_and_uncached}}

The page is served by {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorization_pages.rs router}}; no domain entity is involved.
