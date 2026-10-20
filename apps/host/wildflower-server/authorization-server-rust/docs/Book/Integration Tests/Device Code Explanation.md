# Device Code

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs}}

The device-code flow (RFC 8628) is for a device with no browser of its own to send to `/oauth/authorize`: a TV, a watch, a command line. The device asks at `/oauth/device_authorization`, shows its user a short code, and polls `/oauth/token`. The Owner enters the code on the [Device Page](<Device Page Explanation.md>) and approves. Until then the device hears "not yet".

The request is a [`DeviceRequest`](<../Domain/Authorization Request/Polled Requests Explanation.md#item-DeviceRequest>), one of the [polled requests](<../Domain/Authorization Request/Polled Requests Explanation.md>). The Owner's approval is recorded twice. The request carries the approval the poll redeems ([`DeviceRequest::approve`](<../Domain/Authorization Request/Polled Requests Explanation.md#item-DeviceRequest--approve>)). A standing [`DeviceGrant`](<../Domain/Grant Explanation.md#item-DeviceGrant>) is what the Owner's list of authorized devices shows.

The file also holds the token endpoint's [refresh-token](<../Domain/Refresh Token Explanation.md>) promises, for both flows: rotation, the family's deadline, binding to the client, and what revoking a grant does to its client's refresh tokens.

## `integration::device_code`

### `device_grant_pending_then_slow_down`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs device_grant_pending_then_slow_down}}

Relies on [`DeviceRequest::stamp_poll`](<../Domain/Authorization Request/Polled Requests Explanation.md#item-DeviceRequest--stamp_poll>) and [`DEVICE_CODE_POLL_INTERVAL`](<../Domain/Authorization Request Explanation.md#item-DEVICE_CODE_POLL_INTERVAL>); the poll outcomes are decided in [`ConsumedDeviceRequest::consume`](<../Authority/Redemption Explanation.md#item-ConsumedDeviceRequest--consume>). Fixtures first used here: [`spin_up`](<Test Fixtures Explanation.md#item-spin_up>), [`seed_test_client`](<Test Fixtures Explanation.md#item-seed_test_client>), [`plant_device_request`](<Test Fixtures Explanation.md#item-plant_device_request>), [`store_handle`](<Test Fixtures Explanation.md#item-store_handle>), [`TEST_CLIENT_ID`](<Test Fixtures Explanation.md#item-TEST_CLIENT_ID>), [`TEST_CLIENT_SCOPE`](<Test Fixtures Explanation.md#item-TEST_CLIENT_SCOPE>), [`post_form`](<Test Fixtures Explanation.md#item-post_form>) and [`body_json`](<Test Fixtures Explanation.md#item-body_json>).

### `device_grant_single_use_then_expired_token`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs device_grant_single_use_then_expired_token}}

Relies on [`DeviceRequest::claim`](<../Domain/Authorization Request/Polled Requests Explanation.md#item-DeviceRequest--claim>).

### `device_consent_clamps_granted_scopes_to_client_allowed`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs device_consent_clamps_granted_scopes_to_client_allowed}}

Relies on [`DeviceRequest::approve`](<../Domain/Authorization Request/Polled Requests Explanation.md#item-DeviceRequest--approve>); the clamp is [`DelegatedScopes::clamp`](<../Authority/Delegated Scopes Explanation.md#item-DelegatedScopes--clamp>), with the ceiling [`ApprovableScopes::for_device`](<../Authority/Delegated Scopes Explanation.md#item-ApprovableScopes--for_device>). Fixtures first used here: [`seed_client_with_redirect`](<Test Fixtures Explanation.md#item-seed_client_with_redirect>) and [`build_request`](<Test Fixtures Explanation.md#item-build_request>).

### `device_consent_threads_patient_onto_request`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs device_consent_threads_patient_onto_request}}

Relies on [`DeviceRequest::approve`](<../Domain/Authorization Request/Polled Requests Explanation.md#item-DeviceRequest--approve>).

### `device_consent_allows_expansion_beyond_requested`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs device_consent_allows_expansion_beyond_requested}}

Relies on [`DeviceRequest::approve`](<../Domain/Authorization Request/Polled Requests Explanation.md#item-DeviceRequest--approve>) and [`ApprovableScopes::for_device`](<../Authority/Delegated Scopes Explanation.md#item-ApprovableScopes--for_device>).

### `device_authorization_carries_device_name_to_consent`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs device_authorization_carries_device_name_to_consent}}

Relies on [`NewDeviceRequestArgs`](<../Domain/Authorization Request/Polled Requests Explanation.md#item-NewDeviceRequestArgs>); the prompt is read by [`ConsentReader::device_consent`](<../Capabilities/Access/Device Consents Explanation.md#item-ConsentReader--device_consent>).

### `device_authorization_infers_device_name_from_user_agent_when_unnamed`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs device_authorization_infers_device_name_from_user_agent_when_unnamed}}

Relies on [`device_name_from_user_agent`](<../HTTP/Routes/Device Authorization Explanation.md#item-device_name_from_user_agent>). Fixtures first used here: [`CHROME_MAC_USER_AGENT`](<Test Fixtures Explanation.md#item-CHROME_MAC_USER_AGENT>).

### `explicit_device_name_wins_over_user_agent_inference`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs explicit_device_name_wins_over_user_agent_inference}}

Relies on [`device_name_from_user_agent`](<../HTTP/Routes/Device Authorization Explanation.md#item-device_name_from_user_agent>).

### `device_consent_approver_can_adjust_device_name`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs device_consent_approver_can_adjust_device_name}}

Relies on [`DeviceRequest::approve`](<../Domain/Authorization Request/Polled Requests Explanation.md#item-DeviceRequest--approve>).

### `device_approval_mints_durable_grant_and_links_refresh_family`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs device_approval_mints_durable_grant_and_links_refresh_family}}

Relies on [`DeviceGrant`](<../Domain/Grant Explanation.md#item-DeviceGrant>), [`device_grant_name`](<../Domain/Authorization Request/Polled Requests Explanation.md#item-device_grant_name>) and [`RefreshTokenFamily`](<../Domain/Refresh Token Explanation.md#item-RefreshTokenFamily>).

### `a_device_refresh_stamps_its_grant_s_last_use`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs a_device_refresh_stamps_its_grant_s_last_use}}

Relies on [`DeviceGrant`](<../Domain/Grant Explanation.md#item-DeviceGrant>)'s `last_used_at`, stamped by [`RefreshFamilyWriter::rotate`](<../Writers/Refresh Family Writer Explanation.md#item-RefreshFamilyWriter--rotate>). Fixtures first used here: [`owner_grants_probe`](<Test Fixtures Explanation.md#item-owner_grants_probe>).

### `token_endpoint_rejects_grant_outside_client_allow_list`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs token_endpoint_rejects_grant_outside_client_allow_list}}

Relies on [`AllowedGrantType`](<../Domain/Client Explanation.md#item-AllowedGrantType>); the check is [`ensure_grant_type_allowed`](<../Capabilities/OAuth/Token Exchanger Explanation.md#item-ensure_grant_type_allowed>).

### `device_authorization_sets_cache_suppression_headers`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs device_authorization_sets_cache_suppression_headers}}

Relies on [`CacheSuppressed`](<../HTTP/Errors and Wire Shapes Explanation.md#item-CacheSuppressed>).

### `offline_access_issues_rotating_refresh_token`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs offline_access_issues_rotating_refresh_token}}

Relies on [`consume_refresh_token`](<../Domain/Refresh Token Explanation.md#item-consume_refresh_token>), [`RefreshTokenFamily`](<../Domain/Refresh Token Explanation.md#item-RefreshTokenFamily>), [`RefreshToken`](<../Domain/Refresh Token Explanation.md#item-RefreshToken>) and [`AuthorizationCodeGrant`](<../Domain/Grant Explanation.md#item-AuthorizationCodeGrant>). Fixtures first used here: [`authorize_and_approve`](<Test Fixtures Explanation.md#item-authorize_and_approve>), [`get_authorization_status`](<Test Fixtures Explanation.md#item-get_authorization_status>) and [`CODE_VERIFIER`](<Test Fixtures Explanation.md#item-CODE_VERIFIER>).

### `expired_refresh_token_family_is_rejected`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs expired_refresh_token_family_is_rejected}}

Relies on [`RefreshTokenFamily`](<../Domain/Refresh Token Explanation.md#item-RefreshTokenFamily>); the check is [`ValidatedRefreshToken::validate`](<../Authority/Redemption Explanation.md#item-ValidatedRefreshToken--validate>). Fixtures first used here: [`plant_refresh_token`](<Test Fixtures Explanation.md#item-plant_refresh_token>).

### `refresh_token_is_bound_to_issuing_client`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs refresh_token_is_bound_to_issuing_client}}

Relies on [`RefreshTokenFamily`](<../Domain/Refresh Token Explanation.md#item-RefreshTokenFamily>); the binding is checked in [`ValidatedRefreshToken::validate`](<../Authority/Redemption Explanation.md#item-ValidatedRefreshToken--validate>).

### `revoking_grant_revokes_refresh_tokens`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs revoking_grant_revokes_refresh_tokens}}

Relies on [`RefreshTokenFamily`](<../Domain/Refresh Token Explanation.md#item-RefreshTokenFamily>) and [`GrantsRevoker::revoke`](<../Capabilities/Access/Grants Explanation.md#item-GrantsRevoker--revoke>), which also bumps the client's revocation epoch ([`revoking_a_grant_bumps_the_client_revocation_epoch`](<Revocation Explanation.md#item-revoking_a_grant_bumps_the_client_revocation_epoch>)).
