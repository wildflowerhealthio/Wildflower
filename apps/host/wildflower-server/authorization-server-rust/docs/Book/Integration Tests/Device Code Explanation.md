# Device Code

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs}}

The device-code flow (RFC 8628) is for a device with no browser of its own to send to `/oauth/authorize`: a TV, a watch, a command line. The device asks at `/oauth/device_authorization`, shows its user a short code, and polls `/oauth/token`. The Owner enters the code on the device page and approves. Until then the device hears "not yet".

The request is an [`AuthorizationRequest`](<../Domain/Authorization Request Explanation.md>) of the device kind (`DeviceRequest`). The Owner's approval is recorded twice. The request carries the approval the poll redeems ([`approve_device`](<../Domain/Authorization Request Explanation.md#approve_device>)). A standing [`DeviceGrant`](<../Domain/Grant Explanation.md#devicegrant>) is what Settings lists as an authorized device. Read the [Authorization Request](<../Domain/Authorization Request Explanation.md>) and [Grant](<../Domain/Grant Explanation.md>) pages first.

The file also holds the token endpoint's refresh-token promises, for both flows: rotation, the family's deadline, binding to the client, and what revoking a grant does to its client's refresh tokens. Those lean on the [Refresh Token](<../Domain/Refresh Token Explanation.md>) page.

Most tests stand the request up directly with [`plant_device_request`](<../Integration Tests Explanation.md#plant_device_request>), which keys it by the user code `WILD-FLWR`, and approve it as the Owner at `/authorization/devices/WILD-FLWR/approve`.

## `device_authorization_carries_device_name_to_consent`

**A device may name itself, and the Owner sees that name when deciding.** The name sent to `/oauth/device_authorization` is stored on the request and comes back as `deviceName` on the device page's consent prompt. The prompt also carries `allowedScopes`: everything the client's registration allows, which is how far the Owner may widen the grant.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs device_authorization_carries_device_name_to_consent}}

The name rides on the request's `DeviceRequest` ([Authorization Request](<../Domain/Authorization Request Explanation.md>)); the prompt is read by {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/device.rs ConsentReader::device_consent}}.

## `device_authorization_infers_device_name_from_user_agent_when_unnamed`

**A device that doesn't name itself is named from its `User-Agent`.** A browser-shaped user agent becomes "Browser on OS", here "Chrome on macOS", so the Owner sees something more useful than the client's name.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs device_authorization_infers_device_name_from_user_agent_when_unnamed}}

The inference is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/device_name_hint.rs device_name_from_user_agent}}.

## `explicit_device_name_wins_over_user_agent_inference`

**A name the device gives always beats the inferred one.** The user agent is only consulted when the body names nothing.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs explicit_device_name_wins_over_user_agent_inference}}

## `device_authorization_sets_cache_suppression_headers`

**The device-authorization response is never cached.** It carries a `device_code`, a credential, so it gets `Cache-Control: no-store` and `Pragma: no-cache`, as the token endpoint's response does. The [Cache Suppression](<Cache Suppression Explanation.md>) page covers the rest of the surface.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs device_authorization_sets_cache_suppression_headers}}

## `device_grant_pending_then_slow_down`

**A device that polls too fast is told to slow down.** A poll on a request still pending answers `authorization_pending` and stamps the poll's time on the request. A second poll within the poll interval answers `slow_down`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs device_grant_pending_then_slow_down}}

Relies on [`stamp_device_poll`](<../Domain/Authorization Request Explanation.md#stamp_device_poll>) and {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_request.rs DEVICE_CODE_POLL_INTERVAL}}; the poll outcomes are decided in {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ConsumedDeviceRequest::consume}}.

## `device_grant_single_use_then_expired_token`

**An approval is redeemed once.** The first poll on an approved request claims it and mints the token. The request is then `Claimed`, and the next poll answers `expired_token`, as RFC 8628 has it for a device code already used.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs device_grant_single_use_then_expired_token}}

Relies on [`claim`](<../Domain/Authorization Request Explanation.md#claim>).

## `device_consent_clamps_granted_scopes_to_client_allowed`

**The Owner can't grant a device more than its client's registration allows today.** The request asked for `write` and the Owner ticked it, but the client is now registered for `read` alone. The approval succeeds, and the token carries `read` only. The ceiling is the registration as it stands at approval, not what the request asked for when it was made.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs device_consent_clamps_granted_scopes_to_client_allowed}}

Relies on [`approve_device`](<../Domain/Authorization Request Explanation.md#approve_device>); the clamp is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs DelegatedScopes::clamp}}, with the ceiling {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovableScopes::for_device}}.

## `device_consent_allows_expansion_beyond_requested`

**Device consent is expandable.** The Owner pairing a device may grant scopes the device never asked for, up to its client's registration. Here the device asked for `read`, and the Owner's `write` is recorded on the approval too. The code flow is different: an app's approval stays within what it asked for.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs device_consent_allows_expansion_beyond_requested}}

Relies on [`approve_device`](<../Domain/Authorization Request Explanation.md#approve_device>).

## `device_consent_threads_patient_onto_request`

**A patient the Owner picks when approving a device is bound to the approval.** The `patient` on the approve body lands on the request's approval, and from there on the token the poll mints.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs device_consent_threads_patient_onto_request}}

Relies on [`approve_device`](<../Domain/Authorization Request Explanation.md#approve_device>).

## `device_consent_approver_can_adjust_device_name`

**The Owner may rename the device while approving it.** A `deviceName` on the approve body replaces the name on the request. Approving without one keeps the name the request has.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs device_consent_approver_can_adjust_device_name}}

Relies on [`approve_device`](<../Domain/Authorization Request Explanation.md#approve_device>).

## `device_approval_mints_durable_grant_and_links_refresh_family`

**Approving a device records a standing device grant, and the device's refresh tokens point back to it.** After the approval, the Owner's grant list shows a `device_code` grant titled by the device's name, for its client and the approved scopes. The device's poll then earns an `offline_access` refresh token, and that token's family records the grant's id. The grant is keyed on the device's name, or the client's name when the device has none.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs device_approval_mints_durable_grant_and_links_refresh_family}}

Relies on [`DeviceGrant`](<../Domain/Grant Explanation.md#devicegrant>), [`device_grant_name`](<../Domain/Authorization Request Explanation.md#device_grant_name>) and [`RefreshTokenFamily`](<../Domain/Refresh Token Explanation.md#refreshtokenfamily>). The code-flow half of the same promise is [`offline_access_issues_rotating_refresh_token`](#offline_access_issues_rotating_refresh_token).

## `offline_access_issues_rotating_refresh_token`

**A grant holding `offline_access` earns a refresh token that rotates, and a replayed generation ends the whole family.** The test runs the code flow end to end. The Owner approves, the app redeems the code, and the token response carries a refresh token. Its family records the app's standing authorization-code grant. Redeeming the refresh token gives a fresh access token and a new refresh token. Replaying the old one is treated as theft: it is refused as revoked, and the family ends with it, so the new token is refused too, as expired. The family is ended in place, not deleted.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs offline_access_issues_rotating_refresh_token}}

Relies on [`consume_refresh_token`](<../Domain/Refresh Token Explanation.md#consume_refresh_token>), [`RefreshTokenFamily`](<../Domain/Refresh Token Explanation.md#refreshtokenfamily>), [`RefreshToken`](<../Domain/Refresh Token Explanation.md#refreshtoken>) and [`AuthorizationCodeGrant`](<../Domain/Grant Explanation.md#authorizationcodegrant>).

## `expired_refresh_token_family_is_rejected`

**A family past its deadline refreshes nothing.** The token is refused `invalid_grant`, "Refresh token has expired". The refusal writes nothing: the token is not stamped consumed.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs expired_refresh_token_family_is_rejected}}

Relies on [`RefreshTokenFamily`](<../Domain/Refresh Token Explanation.md#refreshtokenfamily>); the check is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ValidatedRefreshToken::validate}}.

## `refresh_token_is_bound_to_issuing_client`

**A refresh token works only for the client it was issued to.** Another client presenting it gets the answer an unknown token gets, so it learns nothing about the token. The refusal comes before anything is consumed, so the rightful client's token stays live.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs refresh_token_is_bound_to_issuing_client}}

Relies on [`RefreshTokenFamily`](<../Domain/Refresh Token Explanation.md#refreshtokenfamily>); the binding is checked in {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ValidatedRefreshToken::validate}}.

## `token_endpoint_rejects_grant_outside_client_allow_list`

**A client may use only the grant types its registration lists.** A client registered for the code flow alone is refused a refresh with `unauthorized_client`, before any token is looked up.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs token_endpoint_rejects_grant_outside_client_allow_list}}

Relies on the client's allowed grant types ([`AllowedGrantType`](<../Domain/Client Explanation.md#all>)); the check is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs ensure_grant_type_allowed}}.

## `revoking_grant_revokes_refresh_tokens`

**Revoking a grant ends its client's refresh tokens too.** Standing consent and standing credentials die together. After the Owner deletes the grant, every refresh family of that client has its deadline pulled back to the revocation and its live token stamped consumed. The rows stay for the audit trail, and the token is refused as expired.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/device_code.rs revoking_grant_revokes_refresh_tokens}}

Relies on [`AuthorizationCodeGrant`](<../Domain/Grant Explanation.md#authorizationcodegrant>) and [`RefreshTokenFamily`](<../Domain/Refresh Token Explanation.md#refreshtokenfamily>); the cascade is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs GrantsRevoker::revoke}}, which also bumps the client's revocation epoch ([Revocation](<Revocation Explanation.md#revoking_a_grant_bumps_the_client_revocation_epoch>)).
