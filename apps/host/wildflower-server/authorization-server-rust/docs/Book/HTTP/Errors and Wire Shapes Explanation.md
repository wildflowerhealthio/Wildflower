# Errors and Wire Shapes

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/wire_representations.rs}}

These two files are how the server's answers look on the wire. **They render; they decide nothing.** The vocabulary of failure is the domain's [`AuthorizationServerError`](<../Domain/Errors Explanation.md>), and a handler that gets one back from a capability returns it with `?`; this page is where it becomes a status and a body. The same goes for success: the JSON shapes that more than one route sends or reads have one home here, so two surfaces can't drift apart.

Two rules run through the page. **A server-side failure is an opaque `500`**: the detail goes to the operator's log, never to the caller. **A refused credential is a bare `401`** that names, for the host's request log only, why it was refused.

## `verify_error_response`

**What a caller hears when its token doesn't verify.** A token that is bad, expired, for another server or revoked is the caller's problem: a `401`, stamped with the matching `RequestRefusal`. Everything else the [token verifier](<../Capabilities/Session/Token Verifier Explanation.md#verify>) can fail with means the server couldn't check the token at all (no signing keys, a key that won't decode, a store that can't be read), which is the operator's problem: a logged `500`. The match is exhaustive, so a new kind of failure has to be given a status on purpose rather than falling into `401`.

Both bearer gates answer through it (see [`verify_request_claims`](<Middleware Explanation.md#verify_request_claims>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs verify_error_response}}

### What it looks like

The tests read the refusal stamped on a response with one helper:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs tests::stamped_refusal}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs tests::token_rejected_maps_to_401}}

A rejected token is a `401` stamped `TokenRejected`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs tests::revoked_maps_to_401}}

A revoked token is a `401` too, stamped `Revoked`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs tests::no_signing_keys_configured_maps_to_500}}

No signing keys is a `500`, and a `500` carries no refusal.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs tests::key_store_unavailable_maps_to_500}}

A key store that can't be read is a `500`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs tests::signing_key_unreadable_maps_to_500}}

A stored key whose material won't decode is a `500`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs tests::revocation_store_unavailable_maps_to_500}}

A revocation store or a browser-session store that can't be read is a `500`: the server can't prove the token is live, so it neither admits nor blames the caller.

Exercised end to end by [`the_session_gate_stamps_why_it_refused_each_401`](<../Integration Tests/Request Caller Explanation.md#the_session_gate_stamps_why_it_refused_each_401>) and [`the_bearer_gate_stamps_why_it_refused_each_401`](<../Integration Tests/Request Caller Explanation.md#the_bearer_gate_stamps_why_it_refused_each_401>).

## `unauthorized`

**The `401` itself: no body, a `RequestRefusal` in its extensions.** The refusal is for the host's report of forwarded requests, which says why each was turned away; the caller sees only the status. There is no body because the clients declare their `401` without one, and a body that isn't JSON would make their decode fail, so the page would see a parse error instead of a `401`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs unauthorized}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs tests::a_401_has_no_body}}

A missing-token `401` has an empty body.

## `internal_error`

**The opaque `500`**: the error is logged at error level with the context the caller names, and the response is an empty `500`. Token verification's server-side failures render through it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs internal_error}}

No unit test of its own; the `500` tests under [`verify_error_response`](#verify_error_response) go through it. The `/oauth` surfaces' own error enums hold the shared `InternalError` type instead, which this file re-exports; it logs and answers the same opaque `500`.

## How domain errors render

`AuthorizationServerError` renders the same way from every `/authorization` route. Each "not found" is a `404` with a small JSON body naming what wasn't found, keyed by that resource's own identifier. Each refusal of an otherwise valid request is a `409` of the same shape. A missing scope, the caller's or, on an approval, the approver's, is the shared `403` listing the scopes lacking. An infrastructure failure is the logged, empty `500`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs AuthorizationServerError::into_response from="fn into_response" through="AuthorizationServerError::OAuthConsentNotFound" from="AuthorizationServerError::LaunchPatientMismatch" through="AuthorizationServerError::Infrastructure"}}

| Variant                        | Status | Body                                                                                                                                    |
| ------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `OAuthConsentNotFound`         | `404`  | {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs OAuthConsentNotFoundBody}}: `error`, `id`         |
| `DeviceConsentNotFound`        | `404`  | {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs DeviceConsentNotFoundBody}}: `error`, `userCode`  |
| `GrantNotFound`                | `404`  | {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs GrantNotFoundBody}}: `error`, `id`                |
| `BrowserSessionNotFound`       | `404`  | {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs BrowserSessionNotFoundBody}}: `error`, `sid`      |
| `ClientNotFound`               | `404`  | {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs ClientNotFoundBody}}: `error`, `clientId`         |
| `AuthorizationRequestNotFound` | `404`  | {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs AuthorizationRequestNotFoundBody}}: `error`, `id` |
| `EssentialClient`              | `409`  | {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs EssentialClientBody}}: `error`, `clientId`        |
| `RegistrationNotAcknowledged`  | `409`  | {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs RegistrationNotAcknowledgedBody}}: `error`, `id`  |
| `LaunchPatientMismatch`        | `409`  | {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs LaunchPatientMismatchBody}}: `error`, `id`        |
| `InsufficientScope`            | `403`  | the shared insufficient-scope body, the caller's missing scopes                                                                         |
| `InsufficientApproverScope`    | `403`  | the same body, the approver's missing scopes                                                                                            |
| `Infrastructure`               | `500`  | none; logged                                                                                                                            |

`error` is always the variant's name. `EssentialClient` is a request to disable a client the Owner needs to get in; `RegistrationNotAcknowledged` is an approval that went outside the app's registration without the Owner's acknowledgement; `LaunchPatientMismatch` is an approval naming a patient other than the one the app's launch binds.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs tests::launch_patient_mismatch_maps_to_a_tagged_409}}

A launch patient mismatch is a `409` whose body is exactly `{"error": "LaunchPatientMismatch", "id": …}`, the shape the TypeScript client decodes.

The other variants are exercised end to end, for example by [`get_unknown_grant_returns_404`](<../Integration Tests/Smoke Explanation.md#get_unknown_grant_returns_404>) and [`access_grants_delete_with_only_read_scope_returns_403_missing_delete`](<../Integration Tests/Scope Gating Explanation.md#access_grants_delete_with_only_read_scope_returns_403_missing_delete>).

## Error pages

Two front-door routes answer the person at the browser with a page rather than JSON or a redirect. Both are a fixed title and sentence, never request input, in one plain HTML template:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs local_error_page}}

## `oauth_error_html`

**The page `/oauth/authorize` shows when it may not send the browser back to the app.** OAuth lets the server redirect an error to the app only once the redirect is trusted. A refusal made before that, a malformed or unregistered `redirect_uri` for one, leaves nothing safe to redirect to, so the browser gets a `400` with this page instead. Its title comes from a private match over [`OAuthErrorKind`](<../Domain/Errors Explanation.md>), its sentence from the kind's own description, the same sentence a trusted redirect carries as its `error_description`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs oauth_error_html}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs title}}

No unit test here; the integration tests of `/oauth/authorize` assert these pages, for example [OAuth Endpoints](<../Integration Tests/OAuth Endpoints Explanation.md>).

## `sign_in_error_html`

**The page `/oauth/sign-in` shows when it refuses to sign a browser in**: a `next` destination the server doesn't send browsers to, a sign-in code that is unknown, used or expired, or a disabled browser-session client.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs sign_in_error_html}}

No unit test here; exercised end to end by [`an_unknown_code_signs_nobody_in`](<../Integration Tests/Same Device Sign In Explanation.md#an_unknown_code_signs_nobody_in>), [`a_next_anywhere_else_is_refused_and_leaves_the_code_redeemable`](<../Integration Tests/Same Device Sign In Explanation.md#a_next_anywhere_else_is_refused_and_leaves_the_code_redeemable>) and [`a_disabled_browser_session_client_signs_nobody_in_until_re_enabled`](<../Integration Tests/Same Device Sign In Explanation.md#a_disabled_browser_session_client_signs_nobody_in_until_re_enabled>).

## Wire shapes

The rest of the page is the response wrappers and JSON bodies more than one route shares.

## `CacheSuppressed`

**A response that no cache may keep.** Wrapping a response stamps `Cache-Control: no-store` and `Pragma: no-cache` on it, inserted rather than appended, so nothing ends up with the header twice. OAuth requires it of every token response, success or error, and the server applies it more widely: device authorization, the wait page's status poll (whose approved answer carries a redeemable code), the start limit's `429`, sign-out, and, as one layer, every `/authorization` response (see [`cache_suppress`](<Middleware Explanation.md#cache_suppress>)). Making it a wrapper makes it part of the value rather than a step a handler can forget.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/wire_representations.rs CacheSuppressed}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/wire_representations.rs CacheSuppressed::into_response}}

No unit test here; exercised end to end by every test on the [Cache Suppression](<../Integration Tests/Cache Suppression Explanation.md>) page.

## `TokenResponse`

**What the token endpoint gives an app** for a code, a refresh token or a device code: the access token, its type and lifetime, the scopes it holds, a refresh token only when the grant includes `offline_access`, and the patient when the grant is bound to one. The refresh token is the plaintext of a freshly minted generation; only its hash is stored. Rendering it always goes through [`CacheSuppressed`](#cachesuppressed).

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/wire_representations.rs TokenResponse}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/wire_representations.rs TokenResponse::into_response}}

No unit test here; exercised end to end by the [Grant Flows](<../Integration Tests/Grant Flows Explanation.md>) tests.

## `OAuthError`

**The standard OAuth error body**: an `error` code and an optional description, used by the token, revocation and device-authorization endpoints, the wait page's status poll, and client authentication.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/wire_representations.rs OAuthError}}

## `new`

Builds the body from the domain's `OAuthErrorCode`, so a code outside the standard's list can't be written.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/wire_representations.rs OAuthError::new}}

No unit test here; exercised end to end by [`a_malformed_request_is_invalid_request`](<../Integration Tests/Token Revocation Explanation.md#a_malformed_request_is_invalid_request>) and [`an_unknown_client_is_invalid_client`](<../Integration Tests/Token Revocation Explanation.md#an_unknown_client_is_invalid_client>).

## `ApproveBody`

**What the Owner's page posts to approve a device**: the scopes the Owner ticked, an optional patient to bind, and an optional new name for the device. A missing name keeps the device's own name rather than erasing it. Only `POST /authorization/devices/{userCode}/approve` reads it; an app request's approval posts its own body, which carries the registration acknowledgement this one has no need of.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/wire_representations.rs ApproveBody}}

No unit test here; exercised end to end by the [Device Code](<../Integration Tests/Device Code Explanation.md>) tests.

## `ConsentResult`

**What the deciding page hears back after approving or denying**: `approved` or `denied`, and, for an app request, the app's callback URL, carrying the code or `access_denied` and the app's `state`. The consent card, which is the requesting browser itself, follows that redirect directly rather than polling. A device decision has no callback, so `redirect` is left off the wire.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/wire_representations.rs ConsentResult}}

It is rendered from the consent capability's outcome, one variant onto the other:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/wire_representations.rs ConsentResult::from}}

No unit test here; exercised end to end by the [Consent Card](<../Integration Tests/Consent Card Explanation.md>) and [Device Code](<../Integration Tests/Device Code Explanation.md>) tests.
