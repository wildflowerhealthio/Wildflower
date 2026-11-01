//! [`TokenEntitlement`] — what an access token may claim: the closed set of
//! proofs the access-token minter mints under. Each proof carries the claims a
//! token may be minted with **privately**, copied from the record or
//! configuration it stands for, so the minter never accepts a bare scope slice
//! a caller assembled.

use super::browser_pairing::ClaimedBrowserPairing;
use super::redemption::{ConsumedDeviceRequest, RedeemedAuthorizationCode, ValidatedRefreshToken};
use super::same_device_sign_in::RedeemedSameDeviceSignInCode;
use super::session_widening::ClaimedSessionWidening;

/// The proof a token is minted under. The variants are the whole answer to
/// "what can a token be minted for?" — an enum, not a trait, for the reason in
/// the [module docs](super).
#[derive(Clone, Copy)]
pub(crate) enum TokenEntitlement<'a> {
    /// A redeemed same-device sign-in code: the token is the Owner's, for
    /// the same-device session the sign-in starts.
    SameDeviceSignIn(&'a RedeemedSameDeviceSignInCode),
    /// A claimed browser pairing: the token is the paired browser's, for the
    /// paired session the claim starts, with the scopes the Owner granted.
    BrowserPairing(&'a ClaimedBrowserPairing),
    /// A claimed session widening: the token is the widened browser's, for
    /// the same session, with what that session holds now.
    SessionWidening(&'a ClaimedSessionWidening),
    /// An authorization code redeemed at `/oauth/token`: the token carries
    /// the scopes, patient and browser session the code was issued with.
    AuthorizationCode(&'a RedeemedAuthorizationCode),
    /// An approved device request claimed by its poll: the token carries what
    /// the Owner approved, and no browser session.
    DeviceCode(&'a ConsumedDeviceRequest),
    /// A live refresh token, validated before its rotation: the token carries
    /// what its family was started with.
    RefreshToken(&'a ValidatedRefreshToken),
}

impl TokenEntitlement<'_> {
    /// The `sub` / `client_id` the token is issued to: the browser-session
    /// client ([`BROWSER_SESSION_CLIENT_ID`](crate::BROWSER_SESSION_CLIENT_ID))
    /// for a browser session's token, the redeeming app for the rest.
    pub(crate) fn client_id(&self) -> &str {
        match self {
            TokenEntitlement::SameDeviceSignIn(redeemed_sign_in_code) => {
                redeemed_sign_in_code.client_id()
            }
            TokenEntitlement::BrowserPairing(claimed_pairing) => claimed_pairing.client_id(),
            TokenEntitlement::SessionWidening(claimed_widening) => claimed_widening.client_id(),
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
    /// [`wildflowerhealthio_scopes::with_alternate_canonical_forms`]). A
    /// browser session's are the session's scopes as stored.
    pub(crate) fn token_scopes(&self) -> &[String] {
        match self {
            TokenEntitlement::SameDeviceSignIn(redeemed_sign_in_code) => {
                redeemed_sign_in_code.token_scopes()
            }
            TokenEntitlement::BrowserPairing(claimed_pairing) => claimed_pairing.token_scopes(),
            TokenEntitlement::SessionWidening(claimed_widening) => claimed_widening.token_scopes(),
            TokenEntitlement::AuthorizationCode(redeemed_code) => redeemed_code.token_scopes(),
            TokenEntitlement::DeviceCode(consumed_device_request) => {
                consumed_device_request.token_scopes()
            }
            TokenEntitlement::RefreshToken(validated_refresh_token) => {
                validated_refresh_token.token_scopes()
            }
        }
    }

    /// SMART-on-FHIR patient context bound at approval, if any. A browser
    /// session's token has none.
    pub(crate) fn patient(&self) -> Option<&str> {
        match self {
            TokenEntitlement::SameDeviceSignIn(_)
            | TokenEntitlement::BrowserPairing(_)
            | TokenEntitlement::SessionWidening(_) => None,
            TokenEntitlement::AuthorizationCode(redeemed_code) => redeemed_code.patient(),
            TokenEntitlement::DeviceCode(consumed_device_request) => {
                consumed_device_request.patient()
            }
            TokenEntitlement::RefreshToken(validated_refresh_token) => {
                validated_refresh_token.patient()
            }
        }
    }

    /// The browser session the token is minted under, the token's `sid`:
    /// the session a same-device sign-in or a browser pairing started, the one
    /// a claimed widening widened, or the one a redeemed code or refreshed
    /// family records. `None` when there is
    /// none, as for every device-code token: a device pairs with no browser.
    /// Revoking a browser session ends every token naming it.
    pub(crate) fn sid(&self) -> Option<&str> {
        match self {
            TokenEntitlement::SameDeviceSignIn(redeemed_sign_in_code) => {
                Some(redeemed_sign_in_code.session().sid.as_str())
            }
            TokenEntitlement::BrowserPairing(claimed_pairing) => {
                Some(claimed_pairing.session().sid.as_str())
            }
            TokenEntitlement::SessionWidening(claimed_widening) => {
                Some(claimed_widening.session().sid.as_str())
            }
            TokenEntitlement::AuthorizationCode(redeemed_code) => Some(redeemed_code.sid()),
            TokenEntitlement::DeviceCode(_) => None,
            TokenEntitlement::RefreshToken(validated_refresh_token) => {
                validated_refresh_token.sid()
            }
        }
    }
}
