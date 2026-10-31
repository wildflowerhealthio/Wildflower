# Consents

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs}}

A **consent prompt** is a pending request put to whoever may decide it: the Owner, or a paired browser holding enough. There are two surfaces. The **authorization-code prompt** (`/authorization/oauth-consents/{id}`) is an app asking, through a browser, for a [code](<../../Domain/Authorization Request/Code Request Explanation.md>). The **device page's prompt** (`/authorization/devices/{userCode}`) is keyed by the code a device or a browser shows: a [device request or a browser pairing](<../../Domain/Authorization Request/Polled Requests Explanation.md>). Each surface can be read, approved and denied; a code-flow prompt can also be raised for the Owner.

This page holds what the two surfaces share: the three capabilities, the scopes they take, and the shapes the prompt pages read and send. The methods live with their flow, on [OAuth Consents](<OAuth Consents Explanation.md>) and [Device Consents](<Device Consents Explanation.md>).

**Approving a request takes its approval scopes**: the power to decide it, and to create what approving it creates. Deciding takes `wildflower/AuthorizationRequest.u`. A code or device approval records a standing [grant](<../../Domain/Grant Explanation.md>), so it also takes `wildflower/Grant.c`. A code approval for an app trusted on first use writes the app's [registration](<../../Domain/Client Explanation.md>), so it also takes `wildflower/Client.c` and `wildflower/Client.u`. A code approval also takes the resource scopes the request asks for: its approver must be able to approve it as asked. Which of these a request takes depends on the request, so the decider checks them on each call, through the [`DelegatedScopes`](<../../Authority/Delegated Scopes Explanation.md>) proof every approval obtains first. The proof also clamps what the Owner ticked to what the approver holds, so **an approval is never recorded wider than its approver's own authority**.

Every decision is followed by a republish of the [Owner prompt](<../../Domain/Owner Prompt Explanation.md>), once the decision has committed: the decided request is no longer waiting, so the host's popup moves on.

## `domain::capabilities::access::consents`

### `consent_reader_scopes`

It gates both the reader and the raiser: asking the Owner about a prompt decides nothing, so it takes no more than reading it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs consent_reader_scopes}}

### `consent_decider_scopes`

The decider's static gate, and the first approval scope of every approval.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs consent_decider_scopes}}

### `grant_creating_approval_scopes`

A browser pairing records no grant, so approving one doesn't take it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs grant_creating_approval_scopes}}

### `client_registering_approval_scopes`

An app whose registration is fixed takes neither.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs client_registering_approval_scopes}}

### `ConsentReader`

Its reads are [`oauth_consent`](<OAuth Consents Explanation.md#item-ConsentReader--oauth_consent>) and [`device_consent`](<Device Consents Explanation.md#item-ConsentReader--device_consent>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs ConsentReader}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs ConsentReader::new}}

### `ConsentRaiser`

Its one operation is [`raise_for_owner`](<OAuth Consents Explanation.md#item-ConsentRaiser--raise_for_owner>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs ConsentRaiser}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs ConsentRaiser::new}}

### `OwnerRaising`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs OwnerRaising}}

### `ConsentDecider`

Its decisions are [`approve_oauth_consent`](<OAuth Consents Explanation.md#item-ConsentDecider--approve_oauth_consent>), [`deny_oauth_consent`](<OAuth Consents Explanation.md#item-ConsentDecider--deny_oauth_consent>), [`approve_device_consent`](<Device Consents Explanation.md#item-ConsentDecider--approve_device_consent>) and [`deny_device_consent`](<Device Consents Explanation.md#item-ConsentDecider--deny_device_consent>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs ConsentDecider}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs ConsentDecider::new}}

#### `decide_and_republish`

Every decision on both surfaces runs through here.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs ConsentDecider::decide_and_republish}}

### `OAuthConsentView`

What the consent card renders. Its [presented client change](<../../Domain/Client Explanation.md#item-PresentedClientChange>) is worked out from the app's row at the read, so a prompt opened after the registration moved shows the move.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs OAuthConsentView}}

### `DeviceConsentView`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs DeviceConsentView}}

### `SessionWideningConsentView`

What a [session widening's card](<Session Widening Consents Explanation.md>) renders.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs SessionWideningConsentView}}

### `ConsentOutcome`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs ConsentOutcome}}

### `ApproveOAuthConsentInput`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs ApproveOAuthConsentInput}}

### `ApproveDeviceConsentInput`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs ApproveDeviceConsentInput}}
