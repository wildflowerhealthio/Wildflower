//! [`TokenExchangeError`] — the `/oauth/token` failure vocabulary. Each variant
//! is the *specific* reason, so the rules read as a list; the HTTP layer
//! collapses the [`InvalidGrant`](TokenExchangeError::InvalidGrant) reasons
//! onto the generic RFC 6749 §5.2 descriptions (so a response never reveals
//! which check a code or token failed) and logs the reason for the operator.

use chrono::{DateTime, Utc};

use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::token::TokenIssuanceError;

/// Why a grant presented at `/oauth/token` was refused as `invalid_grant`.
/// The fields carry only what an operator needs to tell the cases apart —
/// never the code, verifier, challenge, or token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum InvalidGrantReason {
    /// The authorization code is unknown or already redeemed — a possible
    /// replay; any refresh family minted from the code has been revoked.
    CodeNotFoundOrRedeemed,
    /// The code was issued to a different client.
    CodeClientMismatch {
        code_client_id: String,
        presented_client_id: String,
    },
    /// The presented `redirect_uri` is not the one the code was issued for.
    CodeRedirectMismatch {
        code_redirect_uri: String,
        presented_redirect_uri: String,
    },
    /// The code's lifetime has passed.
    CodeExpired { expires_at: DateTime<Utc> },
    /// The PKCE `code_verifier` does not hash to the parked challenge.
    PkceMismatch { client_id: String },
    /// No device request matches the `device_code` for this client, or the
    /// request is not a device-flow request.
    DeviceRequestNotFound { presented_client_id: String },
    /// Two polls raced for one approved device request; this one lost.
    DeviceCodeAlreadyRedeemed { client_id: String },
    /// No live refresh token has this value.
    RefreshTokenNotFound,
    /// The refresh token belongs to a different client — answered exactly like
    /// not-found so a stranger can't probe validity.
    RefreshTokenClientMismatch {
        family_client_id: String,
        presented_client_id: String,
    },
    /// The family's absolute deadline passed, or it was revoked.
    RefreshTokenExpired,
    /// A consumed refresh token was presented again — theft signal; the whole
    /// family has been revoked.
    RefreshTokenReplayed {
        family_id: String,
        client_id: String,
    },
    /// The token vanished between lookup and rotation.
    RefreshTokenVanished { family_id: String },
}

/// The ways a token exchange can fail. All but [`Issuance`](Self::Issuance) and
/// [`Store`](Self::Store) are the caller's fault and render as `400` with the
/// matching RFC 6749 §5.2 / RFC 8628 §3.5 error code; those two are
/// server-side.
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
    /// RFC 8628 §3.5: the device request is expired (`expired_token`), still
    /// pending (`authorization_pending`), denied (`access_denied`), or polled
    /// too fast (`slow_down`).
    ExpiredToken,
    AuthorizationPending,
    AccessDenied,
    SlowDown,
    /// The token could not be minted after the grant was accepted.
    Issuance(TokenIssuanceError),
    /// A store read or write failed.
    Store(GatekeeperError),
}

impl From<GatekeeperError> for TokenExchangeError {
    fn from(error: GatekeeperError) -> Self {
        TokenExchangeError::Store(error)
    }
}

impl From<TokenIssuanceError> for TokenExchangeError {
    fn from(error: TokenIssuanceError) -> Self {
        TokenExchangeError::Issuance(error)
    }
}
