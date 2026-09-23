//! [`TokenEntitlement`] — what an access token may claim: the closed set of
//! proofs the access-token minter mints under. Each proof carries the claims a
//! token may be minted with **privately**, copied from the record or
//! configuration it stands for, so the minter never accepts a bare scope slice
//! a caller assembled.

use super::host_owner_entitlement::HostOwnerEntitlement;
use super::redemption::{ConsumedDeviceRequest, RedeemedAuthorizationCode, ValidatedRefreshToken};

/// The proof a token is minted under. An enum rather than a trait on purpose:
/// the variants below are the whole answer to "what can a token be minted
/// for?", readable in one place, and a new source of token authority has to be
/// added here, where an audit looks.
#[derive(Clone, Copy)]
pub(crate) enum TokenEntitlement<'a> {
    /// The host's own owner token, minted from configuration at boot.
    HostOwner(&'a HostOwnerEntitlement),
    /// An authorization code redeemed at `/oauth/token`.
    AuthorizationCode(&'a RedeemedAuthorizationCode),
    /// An approved device request claimed by its poll.
    DeviceCode(&'a ConsumedDeviceRequest),
    /// A live refresh token, validated before its rotation.
    RefreshToken(&'a ValidatedRefreshToken),
}

impl TokenEntitlement<'_> {
    /// The `sub` / `client_id` the token is issued to.
    pub(crate) fn client_id(&self) -> &str {
        match self {
            TokenEntitlement::HostOwner(host) => host.client_id(),
            TokenEntitlement::AuthorizationCode(redeemed_code) => redeemed_code.client_id(),
            TokenEntitlement::DeviceCode(consumed_device_request) => {
                consumed_device_request.client_id()
            }
            TokenEntitlement::RefreshToken(validated_refresh_token) => {
                validated_refresh_token.client_id()
            }
        }
    }

    /// The scopes written into the token's `scope` claim, exactly as the proof
    /// holds them. A redemption's differ from its `granted_scopes`: each SMART
    /// scope's alternate spelling is added (see
    /// [`scopes_rust::with_alternate_canonical_forms`]).
    pub(crate) fn token_scopes(&self) -> &[String] {
        match self {
            TokenEntitlement::HostOwner(host) => host.token_scopes(),
            TokenEntitlement::AuthorizationCode(redeemed_code) => redeemed_code.token_scopes(),
            TokenEntitlement::DeviceCode(consumed_device_request) => {
                consumed_device_request.token_scopes()
            }
            TokenEntitlement::RefreshToken(validated_refresh_token) => {
                validated_refresh_token.token_scopes()
            }
        }
    }

    /// SMART-on-FHIR patient context bound at approval, if any. The host's
    /// owner token has none.
    pub(crate) fn patient(&self) -> Option<&str> {
        match self {
            TokenEntitlement::HostOwner(_) => None,
            TokenEntitlement::AuthorizationCode(redeemed_code) => redeemed_code.patient(),
            TokenEntitlement::DeviceCode(consumed_device_request) => {
                consumed_device_request.patient()
            }
            TokenEntitlement::RefreshToken(validated_refresh_token) => {
                validated_refresh_token.patient()
            }
        }
    }

    /// Whether this is the host's own owner token — the one token allowed to
    /// authenticate via the canonical audience at every served origin.
    pub(crate) fn is_host_owner(&self) -> bool {
        matches!(self, TokenEntitlement::HostOwner(_))
    }
}
