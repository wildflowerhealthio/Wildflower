# Consent Routes

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/get.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/approve.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/deny.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/ask_owner.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/devices/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/devices/get.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/devices/approve.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/devices/deny.rs}}

A request that needs a decision is a **consent prompt**, and these routes are where it is read and decided. There are two surfaces. The **code-flow prompt** is an app's [code request](<../../Domain/Authorization Request/Code Request Explanation.md>), keyed by the request's id, which the consent card shows. The **device page's prompt** is keyed by the short user code the device page asks for: a device's request through the device flow, or a browser asking to be paired (the [polled requests](<../../Domain/Authorization Request/Polled Requests Explanation.md>)).

Both surfaces live under `/authorization`, behind the [session gate](<../Middleware Explanation.md#item-require_valid_session>), and no answer is cached. Each handler acquires its capability through `Scoped<…>`: **reading a prompt takes `wildflower/AuthorizationRequest.r`, deciding one takes `wildflower/AuthorizationRequest.u`**, and a token without the scope gets a `403` naming it. The Owner holds both. A paired browser holds only what its pairing granted, so it may be able to read a prompt it can't decide.

The rules of a decision (what an approval may grant, the acknowledgement, the patient, the race with another surface) belong to the capability: [OAuth Consents](<../../Capabilities/Access/OAuth Consents Explanation.md>) for the code flow and [Device Consents](<../../Capabilities/Access/Device Consents Explanation.md>) for the device page. The routes read the body, pass the server's clock, and put the outcome on the wire, as a [`ConsentResult`](<../Errors and Wire Shapes Explanation.md#item-ConsentResult>). The [Consent Card](<../../Integration Tests/Consent Card Explanation.md>), [Approval Scopes](<../../Integration Tests/Approval Scopes Explanation.md>) and [Device Code](<../../Integration Tests/Device Code Explanation.md>) integration tests hold them end to end.

## `http::routes::oauth_consents`

### `router`

Asking the Owner raises a request for the Owner's attention, so that route alone is wrapped in the [deferred start limit](<../Middleware Explanation.md#item-defer_authorization_start_limit>) the caller passes in.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/mod.rs router}}

## `http::routes::oauth_consents::get`

### `handle_get_oauth_consent`

**The consent card loads the prompt it is about to show.** The capability resolves the request against the app's registration as it stands now, and answers `404` when the id names no live code-flow prompt: unknown, decided, expired, still waiting on its own browser's limited page, or for an app disabled since.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/get.rs handle_get_oauth_consent}}

### `OAuthConsent`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/get.rs OAuthConsent}}

### `ClientRegistrationBody`

The [presented client change](<../../Domain/Client Explanation.md#item-PresentedClientChange>) on the wire. Its `WouldWiden` is called `changed` here.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/get.rs ClientRegistrationBody}}

#### `from`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/get.rs ClientRegistrationBody::from}}

## `http::routes::oauth_consents::approve`

### `ApproveOAuthConsentBody`

It has its own shape rather than the device page's [`ApproveBody`](<../Errors and Wire Shapes Explanation.md#item-ApproveBody>), because only this surface carries a registration warning.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/approve.rs ApproveOAuthConsentBody}}

### `handle_approve_oauth_consent`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/approve.rs handle_approve_oauth_consent}}

## `http::routes::oauth_consents::deny`

### `handle_deny_oauth_consent`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/deny.rs handle_deny_oauth_consent}}

## `http::routes::oauth_consents::ask_owner`

### `handle_ask_owner`

**A browser that can read a prompt but not approve it hands it to the Owner.** The capability asks the start limit the layer [deferred](<../Middleware Explanation.md#item-DeferredStartLimit>) onto the request, and only when it is about to raise.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/ask_owner.rs handle_ask_owner}}

## `http::routes::devices`

### `router`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/devices/mod.rs router}}

## `http::routes::devices::get`

### `handle_get_device_consent`

**The device page loads the prompt for the code the approver typed.** A code-flow request never reaches the match: the reader refuses one as not found.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/devices/get.rs handle_get_device_consent}}

### `DeviceConsentKind`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/devices/get.rs DeviceConsentKind}}

### `DeviceConsent`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/devices/get.rs DeviceConsent}}

## `http::routes::devices::approve`

### `handle_approve_device_consent`

A pairing's approval leaves no standing grant: the pairing page's poll starts the browser's session. Neither answer carries a `redirect`, since the device or the browser polls for its result.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/devices/approve.rs handle_approve_device_consent}}

## `http::routes::devices::deny`

### `handle_deny_device_consent`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/devices/deny.rs handle_deny_device_consent}}
