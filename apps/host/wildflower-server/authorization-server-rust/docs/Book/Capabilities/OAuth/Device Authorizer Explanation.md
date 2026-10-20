# Device Authorizer

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs}}

A device with no browser of its own can't send the Owner to a consent card. It asks through the device flow (RFC 8628) instead: it calls `POST /oauth/device_authorization` and gets two codes back, a secret `device_code` it keeps and polls `/oauth/token` with, and a short `user_code` the Owner confirms at the server's device page. The device authorizer starts that flow. It parks a pending [device request](<../../Domain/Authorization Request/Polled Requests Explanation.md>) and republishes the [Owner prompt](<../../Domain/Owner Prompt Explanation.md>), so the host notifies the Owner.

**Starting a device authorization grants nothing.** The scopes it records are what the device asked for. The Owner's approval on the [device page](<../Access/Device Consents Explanation.md>) decides what the device gets, and the [token exchanger's](<Token Exchanger Explanation.md>) poll mints it. Only an app that has [authenticated](<Client Authenticator Explanation.md>) may start one. Unlike `/oauth/authorize`, this door doesn't park a request outside the app's registration for the Owner: it refuses it.

The tests start authorizations for an [authenticated fixture app](<../Test Fixtures Explanation.md#device-authorizer>).

## `domain::capabilities::oauth::device_authorizer`

### `DEVICE_AUTHORIZATION_TTL`

A [browser pairing](<Browser Pairing Explanation.md>), which borrows the device flow's codes and page, gets the same five minutes.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs DEVICE_AUTHORIZATION_TTL}}

### `MAX_USER_CODE_GENERATION_ATTEMPTS`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs MAX_USER_CODE_GENERATION_ATTEMPTS}}

### `DeviceCodes`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs DeviceCodes}}

### `DeviceAuthorizationError`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs DeviceAuthorizationError}}

### `DeviceAuthorizer`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs DeviceAuthorizer}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs DeviceAuthorizer::new}}

#### `device_page`

The route builds the response's `verification_uri` and `verification_uri_complete` from it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs DeviceAuthorizer::device_page}}

#### `start`

The scope check is the [authenticated client's](<../../Authority/Authenticated Client Explanation.md>), by [coverage](<../../Domain/Scopes Explanation.md#item-allowed_scope_covers>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs DeviceAuthorizer::start tests="tests::start_parks_a_pending_request_and_raises_the_popup tests::start_refuses_a_scope_outside_the_allowlist"}}

### `generate_unique_user_code`

A browser pairing draws its `user_code` here too.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs generate_unique_user_code}}
