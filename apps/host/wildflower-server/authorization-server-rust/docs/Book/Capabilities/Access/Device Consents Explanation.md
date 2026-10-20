# Device Consents

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/device.rs}}

The device page is where a code shown somewhere else gets decided. A device (a watch, a TV) shows a user code from the device flow; a browser that isn't the Owner's shows one from a browser pairing. Both are [polled requests](<../../Domain/Authorization Request/Polled Requests Explanation.md>), keyed by their `user_code`. The approver opens `/authorization/devices/{userCode}`, sees what is asked, and approves or denies. The capabilities are declared on [Consents](<Consents Explanation.md>).

**Device consent is expandable**: the approver may grant more than the device asked for, up to an envelope. For a device the envelope is the app's registered scopes; for a browser pairing it is the Owner's scopes, so no paired browser can hold more than a same-device session. Either way the [`DelegatedScopes`](<../../Authority/Delegated Scopes Explanation.md>) clamp also bounds every resource scope by what the approver holds.

A device approval records a standing **device grant**, keyed by the app and the device's name, through the [grant recorder](<../../Writers/Grant Recorder Explanation.md>). A pairing records no grant: the pairing page's poll starts the paired session once the request is approved. Neither approval has a callback to send a browser to; the device or the pairing page learns the decision by polling.

The tests decide through the [consent fixtures](<../Test Fixtures Explanation.md#consents>).

## `domain::capabilities::access::consents::device`

### `load_pending_request_by_user_code`

A code-flow request under the same code is not found here: it has its own prompt.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/device.rs load_pending_request_by_user_code}}

### `ConsentReader`

#### `device_consent`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/device.rs ConsentReader::device_consent}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::consent_reader_says_which_approval_scopes_a_device_prompt_takes}}

### `ConsentDecider`

#### `approve_device_consent`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/device.rs ConsentDecider::approve_device_consent}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_device_consent_expands_to_client_allowed_and_republishes}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_device_consent_rejects_a_resource_scope_the_approver_cannot_delegate}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_device_consent_allows_a_resource_scope_the_approver_holds}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_device_consent_requires_creating_the_grant_but_a_pairing_does_not}}

#### `approve_device_in`

The device's own transition is [`DeviceRequest::approve`](<../../Domain/Authorization Request/Polled Requests Explanation.md#item-DeviceRequest--approve>), and the grant is named by [`device_grant_name`](<../../Domain/Authorization Request/Polled Requests Explanation.md#item-device_grant_name>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/device.rs ConsentDecider::approve_device_in}}

#### `approve_browser_pairing_in`

The pairing's own transition is [`PairingRequest::approve`](<../../Domain/Authorization Request/Polled Requests Explanation.md#item-PairingRequest--approve>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/device.rs ConsentDecider::approve_browser_pairing_in}}

#### `deny_device_consent`

The device's next poll hears `access_denied`; a pairing page sets no cookie.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/device.rs ConsentDecider::deny_device_consent}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::deny_device_consent_marks_denied_and_republishes}}

### `deny_device_request`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/device.rs deny_device_request}}

### `deny_pairing_request`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/device.rs deny_pairing_request}}
