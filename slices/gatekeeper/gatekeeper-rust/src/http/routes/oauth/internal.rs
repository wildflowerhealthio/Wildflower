use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;

use super::client_auth::{
    ClientAuthenticationMethod, ResolveClientCredentialsError, BASIC_AUTH_CHALLENGE,
};
use crate::domain::authority::ClientAuthenticationError;
use crate::domain::oauth_error_code::OAuthErrorCode;
use crate::domain::token::TokenIssuanceError;
use crate::domain::token_exchange_error::{InvalidGrantReason, TokenExchangeError};
use crate::http::errors::InternalError;
use crate::http::wire_representations::{CacheSuppressed, OAuthError};

/// An [`OAuthError`] paired with the HTTP status it renders at — the
/// `(status, JSON body)` shape every OAuth-surface error response shares.
#[derive(Debug)]
pub struct OAuthErrorResponse {
    pub status: StatusCode,
    pub error: OAuthError,
}

impl OAuthErrorResponse {
    pub fn new(status: StatusCode, error: OAuthErrorCode, description: Option<&str>) -> Self {
        Self {
            status,
            error: OAuthError::new(error, description),
        }
    }

    /// A `server_error` 500 carrying the RFC 6749 §5.2 body — the shape every
    /// "the server failed mid-flow" OAuth response shares. Shared so a surface
    /// like the Owner-UI polling page (which mixes `GatekeeperError` with a
    /// non-cache-suppressed `OAuthErrorResponse`, so it can't use `TokenError`)
    /// doesn't hand-roll the status + code each time.
    pub fn server_error(description: &str) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            OAuthErrorCode::ServerError,
            Some(description),
        )
    }
}

impl IntoResponse for OAuthErrorResponse {
    fn into_response(self) -> Response {
        (self.status, Json(self.error)).into_response()
    }
}

/// Error half of the token / device-authorization endpoints' `Result`-returning
/// handlers (the OAuth-surface analogue of the Owner `/access` surface's
/// [`GatekeeperError`](crate::domain::gatekeeper_error::GatekeeperError)). Every
/// variant renders the matching RFC 6749 §5.2 response, cache-suppressed per
/// §5.1, through `IntoResponse` — so a fallible step bails with `?` instead of
/// a `match` + `return` at each call site. Kept small (no embedded `Response`)
/// so `Result<_, TokenError>` doesn't trip `clippy::result_large_err`.
pub enum TokenError {
    /// An OAuth error body at its status: the §5.2 400s (`invalid_grant`,
    /// `unauthorized_client`, `invalid_request`, `invalid_scope`, `slow_down`,
    /// …) and the JSON-bodied 500 from a token-mint failure.
    Oauth(OAuthErrorResponse),
    /// Client-credential resolution failure (RFC 6749 §2.3) — renders its own
    /// response, possibly with a `WWW-Authenticate: Basic` challenge.
    ResolveCredentials(ResolveClientCredentialsError),
    /// Client-authentication failure — renders its own response, possibly with
    /// a `WWW-Authenticate: Basic` challenge.
    ClientAuth(ClientAuthenticationFailure),
    /// A logged, opaque, cache-suppressed 500 (e.g. a store read failed) —
    /// see [`InternalError`].
    Internal(InternalError),
}

impl TokenError {
    /// A 400 OAuth error: the `error` code plus an optional human-readable
    /// `description` (RFC 6749 §5.2).
    pub fn bad_request(error: OAuthErrorCode, description: Option<&str>) -> Self {
        TokenError::Oauth(OAuthErrorResponse::new(
            StatusCode::BAD_REQUEST,
            error,
            description,
        ))
    }

    /// An OAuth `server_error` 500 with a JSON body — used when token minting
    /// fails after the request was otherwise valid.
    pub fn server_error(error: OAuthError) -> Self {
        TokenError::Oauth(OAuthErrorResponse {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            error,
        })
    }

    /// A server-side failure: logs `source` against `context` and 500s opaquely.
    pub fn internal(context: &'static str, source: impl std::fmt::Display) -> Self {
        TokenError::Internal(InternalError::new(context, source))
    }
}

/// Render a domain failure on the token surface: any store failure — expected
/// only the opaque
/// [`Infrastructure`](crate::domain::gatekeeper_error::GatekeeperError::Infrastructure)
/// variant here — becomes the logged, cache-suppressed opaque 500. This `From`
/// is what lets the exchange helpers `?` a `Result<_, GatekeeperError>` from
/// a domain action.
impl From<crate::domain::gatekeeper_error::GatekeeperError> for TokenError {
    fn from(error: crate::domain::gatekeeper_error::GatekeeperError) -> Self {
        TokenError::Internal(InternalError::new(
            "store operation failed on the token surface",
            error,
        ))
    }
}

/// Render the exchange flows' failure vocabulary onto RFC 6749 §5.2 / RFC 8628
/// §3.5. The [`InvalidGrant`](TokenExchangeError::InvalidGrant) reasons collapse
/// onto one generic description per grant type — distinguishing "wrong client"
/// from "wrong redirect_uri" from "expired" from "bad verifier" would leak facts
/// about a code that may belong to another client — and the specific reason is
/// logged (it carries no secrets) so the operator can still tell them apart.
impl From<TokenExchangeError> for TokenError {
    fn from(error: TokenExchangeError) -> Self {
        match error {
            TokenExchangeError::UnauthorizedGrantType => TokenError::bad_request(
                OAuthErrorCode::UnauthorizedClient,
                Some("Client may not use this grant type"),
            ),
            TokenExchangeError::InvalidCodeVerifier => TokenError::bad_request(
                OAuthErrorCode::InvalidGrant,
                Some("Invalid code_verifier parameter"),
            ),
            TokenExchangeError::InvalidRedirectUri => TokenError::bad_request(
                OAuthErrorCode::InvalidRequest,
                Some("Invalid redirect_uri parameter"),
            ),
            TokenExchangeError::InvalidGrant(reason) => {
                tracing::warn!(?reason, "token exchange rejected");
                TokenError::bad_request(
                    OAuthErrorCode::InvalidGrant,
                    Some(invalid_grant_description(&reason)),
                )
            }
            TokenExchangeError::ExpiredToken => {
                TokenError::bad_request(OAuthErrorCode::ExpiredToken, None)
            }
            TokenExchangeError::AuthorizationPending => {
                TokenError::bad_request(OAuthErrorCode::AuthorizationPending, None)
            }
            TokenExchangeError::AccessDenied => {
                TokenError::bad_request(OAuthErrorCode::AccessDenied, None)
            }
            TokenExchangeError::SlowDown => TokenError::bad_request(OAuthErrorCode::SlowDown, None),
            TokenExchangeError::Issuance(error) => {
                tracing::error!(%error, "access token issuance failed");
                let description = match error {
                    TokenIssuanceError::NoActiveSigningKey | TokenIssuanceError::Store(_) => {
                        "No JSON Web Keys available to sign token"
                    }
                    TokenIssuanceError::Signing(_) => "Failed to sign JWT",
                };
                TokenError::server_error(OAuthError::new(
                    OAuthErrorCode::ServerError,
                    Some(description),
                ))
            }
            TokenExchangeError::Store(error) => TokenError::from(error),
        }
    }
}

/// The one wire description each family of refusal shares (see
/// [`From<TokenExchangeError>`](TokenError)).
fn invalid_grant_description(reason: &InvalidGrantReason) -> &'static str {
    match reason {
        InvalidGrantReason::CodeNotFoundOrRedeemed
        | InvalidGrantReason::CodeClientMismatch { .. }
        | InvalidGrantReason::CodeRedirectMismatch { .. }
        | InvalidGrantReason::CodeExpired { .. }
        | InvalidGrantReason::PkceMismatch { .. } => "Invalid authorization grant",
        InvalidGrantReason::DeviceRequestNotFound { .. } => "Unknown device_code",
        InvalidGrantReason::DeviceCodeAlreadyRedeemed { .. } => "Device code already redeemed",
        InvalidGrantReason::RefreshTokenNotFound
        | InvalidGrantReason::RefreshTokenClientMismatch { .. }
        | InvalidGrantReason::RefreshTokenVanished { .. } => "Invalid refresh_token parameter",
        InvalidGrantReason::RefreshTokenExpired => "Refresh token has expired",
        InvalidGrantReason::RefreshTokenReplayed { .. } => "Refresh token has been revoked",
    }
}

impl From<ResolveClientCredentialsError> for TokenError {
    fn from(error: ResolveClientCredentialsError) -> Self {
        TokenError::ResolveCredentials(error)
    }
}

impl From<ClientAuthenticationFailure> for TokenError {
    fn from(error: ClientAuthenticationFailure) -> Self {
        TokenError::ClientAuth(error)
    }
}

impl IntoResponse for TokenError {
    fn into_response(self) -> Response {
        match self {
            TokenError::Oauth(response) => CacheSuppressed(response).into_response(),
            TokenError::ResolveCredentials(error) => CacheSuppressed(error).into_response(),
            TokenError::ClientAuth(error) => CacheSuppressed(error).into_response(),
            TokenError::Internal(error) => CacheSuppressed(error).into_response(),
        }
    }
}

/// A domain [`ClientAuthenticationError`] paired with how the client
/// authenticated, which is what the rendering needs: RFC 6749 §5.2 says a `401`
/// answering a Basic-authentication attempt carries a matching
/// `WWW-Authenticate: Basic` challenge.
#[derive(Debug)]
pub struct ClientAuthenticationFailure {
    pub error: ClientAuthenticationError,
    pub presented_via: ClientAuthenticationMethod,
}

impl IntoResponse for ClientAuthenticationFailure {
    /// The caller's-fault variants render as `401 invalid_client` with a
    /// description naming the check; the server-side ones log and render as
    /// `500 server_error` with no detail.
    fn into_response(self) -> Response {
        let server_error = || {
            OAuthErrorResponse::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                OAuthErrorCode::ServerError,
                None,
            )
            .into_response()
        };
        let description = match self.error {
            ClientAuthenticationError::UnknownClient => "Unknown client_id",
            ClientAuthenticationError::Disabled => "Client is disabled",
            ClientAuthenticationError::SecretNotConfigured => "Client secret not configured",
            ClientAuthenticationError::SecretRequired => "Client secret required",
            ClientAuthenticationError::SecretMismatch => "Invalid client_secret",
            ClientAuthenticationError::Verification(error) => {
                tracing::error!(%error, "client secret verification failed");
                return server_error();
            }
            ClientAuthenticationError::Store(error) => {
                tracing::error!(%error, "client_by_id lookup failed");
                return server_error();
            }
        };
        let unauthorized = OAuthErrorResponse::new(
            StatusCode::UNAUTHORIZED,
            OAuthErrorCode::InvalidClient,
            Some(description),
        );
        match self.presented_via {
            ClientAuthenticationMethod::HttpBasic => (
                [(header::WWW_AUTHENTICATE, BASIC_AUTH_CHALLENGE)],
                unauthorized,
            )
                .into_response(),
            ClientAuthenticationMethod::RequestBody => unauthorized.into_response(),
        }
    }
}
