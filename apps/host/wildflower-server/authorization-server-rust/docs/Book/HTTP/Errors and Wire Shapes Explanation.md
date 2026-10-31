# Errors and Wire Shapes

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/wire_representations.rs}}

These two files are how the server's answers look on the wire. **They render; they decide nothing.** The vocabulary of failure is the domain's [`AuthorizationServerError`](<../Domain/Errors Explanation.md#item-AuthorizationServerError>), and a handler that gets one back from a capability returns it with `?`; this page is where it becomes a status and a body. The same goes for success: the JSON shapes that more than one route sends or reads have one home here, so two surfaces can't drift apart.

Two rules run through the page. **A server-side failure is an opaque `500`**: the detail goes to the operator's log, never to the caller. **A refused credential is a bare `401`** that names, for the host's request log only, why it was refused.

## `http::errors`

### `verify_error_response`

Both bearer gates answer through it (see [`verify_request_claims`](<Middleware Explanation.md#item-verify_request_claims>)). The tests read the refusal on a response with [`stamped_refusal`](<Test Fixtures Explanation.md#errors-and-wire-shapes>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs verify_error_response tests="tests::token_rejected_maps_to_401 tests::revoked_maps_to_401 tests::no_signing_keys_configured_maps_to_500 tests::key_store_unavailable_maps_to_500 tests::signing_key_unreadable_maps_to_500 tests::revocation_store_unavailable_maps_to_500"}}

### `unauthorized`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs unauthorized tests="tests::a_401_has_no_body"}}

### `internal_error`

The `/oauth` surfaces' error enums hold the shared `InternalError` instead, which this file re-exports from `shared-structures-rust`; it logs and answers the same opaque `500`.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs internal_error}}

### `AuthorizationServerError`

**Every `/authorization` route renders the domain's failures the same way.** Each body carries `error`, the variant's name, and one key, the identifier the caller sent. Each "not found" is a `404`. Each refusal of an otherwise valid request is a `409` of the same shape. A missing scope, the caller's or, on an approval, the approver's, is the shared `403` listing the scopes lacking, from `scope-capabilities-rust`. An infrastructure failure is the logged, empty `500`.

#### `into_response`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs AuthorizationServerError::into_response tests="tests::launch_patient_mismatch_maps_to_a_tagged_409"}}

### The bodies

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs OAuthConsentNotFoundBody}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs DeviceConsentNotFoundBody}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs AuthorizationRequestNotFoundBody}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs SessionWideningNotFoundBody}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs GrantNotFoundBody}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs BrowserSessionNotFoundBody}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs ClientNotFoundBody}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs EssentialClientBody}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs RegistrationNotAcknowledgedBody}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs LaunchPatientMismatchBody}}

### Error pages

Two front-door routes answer the person at the browser with a page rather than JSON or a redirect: `/oauth/authorize`, when it may not send the browser back to the app, and `/oauth/sign-in`, when it refuses to sign a browser in.

#### `oauth_error_html`

OAuth lets the server redirect an error to the app only once the redirect is trusted. A refusal made before that, a malformed or unregistered `redirect_uri` for one, leaves nothing safe to redirect to, so the browser gets a `400` with this page. Its sentence is the [`AuthorizeRefusal`](<../Domain/Errors Explanation.md#item-AuthorizeRefusal>)'s own description, the same sentence a trusted redirect carries as its `error_description`.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs oauth_error_html}}

#### `title`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs title}}

#### `sign_in_error_html`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs sign_in_error_html}}

#### `local_error_page`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/errors.rs local_error_page}}

## `http::wire_representations`

### `CacheSuppressed`

OAuth requires it of every token response, success or error, and the server applies it more widely. Making it a wrapper makes it part of the value rather than a step a handler can forget; [`cache_suppress`](<Middleware Explanation.md#item-cache_suppress>) applies it as one layer to all of `/authorization`.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/wire_representations.rs CacheSuppressed}}

#### `into_response`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/wire_representations.rs CacheSuppressed::into_response}}

### `TokenResponse`

The refresh token is the plaintext of a freshly minted generation of the [refresh-token family](<../Domain/Refresh Token Explanation.md>); only its hash is stored.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/wire_representations.rs TokenResponse}}

#### `into_response`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/wire_representations.rs TokenResponse::into_response}}

### `OAuthError`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/wire_representations.rs OAuthError}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/wire_representations.rs OAuthError::new}}

### `ApproveBody`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/wire_representations.rs ApproveBody}}

### `ConsentResult`

The consent card is the requesting browser itself, so it follows the redirect directly rather than polling.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/wire_representations.rs ConsentResult}}

#### `from`

The consent capability's [`ConsentOutcome`](<../Capabilities/Access/Consents Explanation.md>), variant for variant.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/wire_representations.rs ConsentResult::from}}
