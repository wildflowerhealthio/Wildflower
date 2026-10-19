# Revocation

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/revocation.rs}}

An access token is a signed JWT that stays valid until it expires. Revocation is how the server stops one early. It keeps two records, in a revocation store shared with the FHIR server:

- **The `jti` denylist** ends one token: the row lives until the token would have expired anyway.
- **The subject epoch** ends a whole cohort: every token issued to a subject (its `sub`, the `client_id`) before the epoch is revoked.

Every `/authorization` bearer gate checks both. A revoked token is `401`, the same as no token. These tests probe the gate with [`owner_grants_probe`](<../Integration Tests Explanation.md#owner_grants_probe>), the smallest Owner-gated call, and plant or read revocations through [`revocation_store_handle`](<../Integration Tests Explanation.md#revocation_store_handle>).

Revocation is written in three places: the Owner's `POST /authorization/revocations`, logout, and revoking a grant. The [Token](<../Domain/Token Explanation.md>) and [Grant](<../Domain/Grant Explanation.md>) pages come first; the [Token Revocation](<Token Revocation Explanation.md>) page covers an app revoking its own tokens.

## Helpers

The gate's answer for a token, and a token issued to the Wildflower host app's client holding only `openid`, which reaches no `/authorization` scope gate:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/revocation.rs gate_status}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/revocation.rs mint_host_app_token}}

## `gate_allows_a_live_token_across_repeated_requests`

**A live token keeps working.** Revocation must not make a bearer single-use: the same token passes the gate request after request.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/revocation.rs gate_allows_a_live_token_across_repeated_requests}}

## `gate_rejects_a_revoked_jti`

**A denylisted `jti` is rejected.** The token passes, its `jti` is denylisted, and the same token is then `401`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/revocation.rs gate_rejects_a_revoked_jti}}

Relies on [`AccessTokenClaims`](<../Domain/Token Explanation.md#accesstokenclaims>).

## `gate_rejects_after_subject_epoch_bump`

**Bumping a subject's epoch revokes the tokens it was issued before.** The epoch is set a second ahead, because a token's `iat` is whole seconds and the token was minted moments earlier.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/revocation.rs gate_rejects_after_subject_epoch_bump}}

## `logout_revokes_the_presented_jti`

**Logging out revokes the token that logged out.** Logout redirects (`303`) to the launcher, and denylists the presented token's `jti`, so a leaked copy can't ride on until it expires.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/revocation.rs logout_revokes_the_presented_jti}}

The route is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/routes/logout.rs handle_logout}}.

## `revocations_endpoint_revokes_by_jti`

**The Owner can revoke one token by its `jti`.** The body names the `jti` and the token's own expiry. Here the Owner revokes the very token it calls with, which then stops working.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/revocation.rs revocations_endpoint_revokes_by_jti}}

The route is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/routes/revocations.rs handle_create_revocation}}.

## `revocations_endpoint_bulk_revokes_by_subject`

**The Owner can revoke everything a client holds by naming it as the subject.** The subject's epoch moves to now, so a token issued to it an hour ago reads back revoked.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/revocation.rs revocations_endpoint_bulk_revokes_by_subject}}

## `revocations_endpoint_rejects_invalid_bodies`

**A revocation names exactly one mode, completely.** A `jti` without `expiresAt`, both modes at once, neither, and an `expiresAt` already past are all `400`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/revocation.rs revocations_endpoint_rejects_invalid_bodies}}

The body is checked by {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/routes/revocations.rs RevocationRequest::into_revocation}}, and the past `expiresAt` by the route.

## `revocations_endpoint_requires_owner_auth`

**No bearer, no revocation.** The call is `401`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/revocation.rs revocations_endpoint_requires_owner_auth}}

## `revoking_a_grant_bumps_the_client_revocation_epoch`

**Revoking a grant revokes its client's live access tokens.** Deleting the grant bumps the client's epoch, so a token issued to it an hour ago reads back revoked. The grant's refresh tokens end too ([`revoking_grant_revokes_refresh_tokens`](<Device Code Explanation.md#revoking_grant_revokes_refresh_tokens>)).

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/revocation.rs revoking_a_grant_bumps_the_client_revocation_epoch}}

Relies on [`AuthorizationCodeGrant`](<../Domain/Grant Explanation.md#authorizationcodegrant>); the cascade is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs GrantsRevoker::revoke}}.

## `revoking_a_device_grant_bumps_the_client_revocation_epoch`

**Revoking an authorized device does the same.** A device grant is revoked through the same `DELETE /authorization/grants/{id}`, and bumps its client's epoch just as a code grant does. The epoch is per client, so this revokes every live access token of that client, not only the device's.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/revocation.rs revoking_a_device_grant_bumps_the_client_revocation_epoch}}

Relies on [`DeviceGrant`](<../Domain/Grant Explanation.md#devicegrant>).

## `revoking_the_host_app_s_subject_revokes_its_tokens`

**The Wildflower host app's client gets no exemption from a subject revoke.** Its token is live, so the gate answers `403` (it reaches no scope there). After the Owner revokes the host app's subject, the gate rejects it outright: `401`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/revocation.rs revoking_the_host_app_s_subject_revokes_its_tokens}}

## `revoking_a_grant_of_the_host_app_s_client_bumps_its_epoch`

**Nor from a grant revoke.** Revoking a grant of the host app's client deletes it and bumps the host app's epoch, like any other client's.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/revocation.rs revoking_a_grant_of_the_host_app_s_client_bumps_its_epoch}}

Relies on [`DeviceGrant`](<../Domain/Grant Explanation.md#devicegrant>).
