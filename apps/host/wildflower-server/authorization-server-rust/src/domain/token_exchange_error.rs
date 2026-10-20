//! [`TokenExchangeError`] — the `/oauth/token` failure vocabulary. Each variant
//! is the *specific* reason, so the rules read as a list; the HTTP layer
//! collapses the [`InvalidGrant`](TokenExchangeError::InvalidGrant) reasons
//! onto a few RFC 6749 §5.2 descriptions and logs the reason for the operator:
//! every code refusal shares one (so a response never reveals which check a
//! code failed), a device code's are unknown or already redeemed, and a
//! refresh token's are invalid, expired or revoked.

use chrono::{DateTime, Utc};

use crate::domain::access_token::AccessTokenIssuanceError;
use crate::domain::authorization_server_error::AuthorizationServerError;

/// Why a grant presented at `/oauth/token` was refused as `invalid_grant`.
/// The specific reason goes to the operator's log; the app hears one generic
/// description per family of reasons. The fields carry only what an operator
/// needs to tell the cases apart — never the code, verifier, challenge, or
/// token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum InvalidGrantReason {
    /// The authorization code is unknown or already redeemed — a possible
    /// replay; any refresh family minted from the code has been revoked.
    CodeNotFoundOrRedeemed,
    /// The code was issued to a different client.
    CodeClientMismatch {
        /// The client the code was issued to.
        code_client_id: String,
        /// The client that presented it.
        presented_client_id: String,
    },
    /// The presented `redirect_uri` is not the one the code was issued for.
    CodeRedirectMismatch {
        /// The redirect the code was issued for.
        code_redirect_uri: String,
        /// The redirect the redeemer named.
        presented_redirect_uri: String,
    },
    /// The code's lifetime has passed.
    CodeExpired {
        /// When the code stopped being redeemable.
        expires_at: DateTime<Utc>,
    },
    /// The PKCE `code_verifier` does not hash to the parked challenge.
    PkceMismatch {
        /// The client that presented the code.
        client_id: String,
    },
    /// No device request matches the `device_code` for this client: none
    /// exists, or it belongs to another client, which reads the same.
    DeviceRequestNotFound {
        /// The client that presented the `device_code`.
        presented_client_id: String,
    },
    /// Two polls raced for one approved device request; this one lost.
    DeviceCodeAlreadyRedeemed {
        /// The client the device request belongs to.
        client_id: String,
    },
    /// No live refresh token has this value.
    RefreshTokenNotFound,
    /// The refresh token belongs to a different client — answered exactly like
    /// not-found so a stranger can't probe validity.
    RefreshTokenClientMismatch {
        /// The client the family was issued to.
        family_client_id: String,
        /// The client that presented the token.
        presented_client_id: String,
    },
    /// The family's absolute deadline passed, or it was ended (revoked or
    /// replayed), which moves the deadline to that moment.
    RefreshTokenExpired,
    /// The browser session the family was minted under has been revoked, or
    /// no longer exists.
    RefreshTokenSessionRevoked {
        /// The family whose browser session ended.
        family_id: String,
    },
    /// The family began before its client's revocation epoch: bumping the
    /// epoch revoked every token the client held then.
    RefreshTokenClientRevoked {
        /// The family issued before the client's tokens were revoked.
        family_id: String,
    },
    /// A consumed refresh token was presented again — theft signal; the whole
    /// family has been revoked.
    RefreshTokenReplayed {
        /// The family that has been revoked.
        family_id: String,
        /// The client the family was issued to.
        client_id: String,
    },
    /// The token vanished between lookup and rotation.
    RefreshTokenVanished {
        /// The family the token was looked up in.
        family_id: String,
    },
}

/// The ways a token exchange can fail. All but [`Issuance`](Self::Issuance) and
/// [`Store`](Self::Store) are the caller's fault and render as `400` with the
/// matching RFC 6749 §5.2 / RFC 8628 §3.5 error code; those two are
/// server-side. Its audience is an app at `/oauth/token`, and the operator's
/// log, which gets the specific reason. An [`AuthorizationServerError`] from
/// the store becomes [`Store`](Self::Store) and a signing failure becomes
/// [`Issuance`](Self::Issuance), so the exchange flows can use `?` on either.
#[derive(Debug)]
pub(crate) enum TokenExchangeError {
    /// The authenticated client's registration does not allow this grant type
    /// (`unauthorized_client`).
    UnauthorizedGrantType,
    /// The PKCE `code_verifier` is not 43–128 characters (RFC 7636 §4.1) — an
    /// `invalid_grant`, not a malformed request.
    InvalidCodeVerifier,
    /// The presented `redirect_uri` does not parse (`invalid_request`).
    InvalidRedirectUri,
    /// The grant itself was refused (`invalid_grant`), for the given reason.
    InvalidGrant(InvalidGrantReason),
    /// RFC 8628 §3.5 `expired_token`: the device request is past its expiry,
    /// or was already claimed by an earlier poll that minted its token.
    ExpiredToken,
    /// RFC 8628 §3.5 `authorization_pending`: the device request still waits
    /// for the Owner; the device keeps polling.
    AuthorizationPending,
    /// RFC 8628 §3.5 `access_denied`: the Owner denied the device request.
    AccessDenied,
    /// RFC 8628 §3.5 `slow_down`: the device polled a pending request sooner
    /// than the advertised interval allows.
    SlowDown,
    /// The token could not be minted after the grant was accepted; the
    /// exchange's scope was rolled back with it, so nothing was consumed. A
    /// `server_error` 500.
    Issuance(AccessTokenIssuanceError),
    /// A store read or write failed: an empty 500, logged.
    Store(AuthorizationServerError),
}

impl From<AuthorizationServerError> for TokenExchangeError {
    fn from(error: AuthorizationServerError) -> Self {
        TokenExchangeError::Store(error)
    }
}

impl From<AccessTokenIssuanceError> for TokenExchangeError {
    fn from(error: AccessTokenIssuanceError) -> Self {
        TokenExchangeError::Issuance(error)
    }
}
