//! The OAuth surface's error responses: [`OAuthErrorResponse`], the
//! [`TokenError`] the token-style routes answer with, and
//! [`ClientAuthenticationFailure`].

use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;

use super::client_auth::{
    ClientAuthenticationMethod, ResolveClientCredentialsError, BASIC_AUTH_CHALLENGE,
};
use crate::domain::access_token::AccessTokenIssuanceError;
use crate::domain::authority::ClientAuthenticationError;
use crate::domain::oauth_error_code::OAuthErrorCode;
use crate::domain::token_exchange_error::{InvalidGrantReason, TokenExchangeError};
use crate::http::errors::InternalError;
use crate::http::wire_representations::{CacheSuppressed, OAuthError};

/// An [`OAuthError`] paired with the HTTP status it renders at — the
/// `(status, JSON body)` shape every OAuth-surface error response shares.
/// On its own it isn't cache-suppressed: the status poll renders it that way,
/// and the token-style routes wrap it in [`TokenError`], which is.
#[derive(Debug)]
pub struct OAuthErrorResponse {
    /// The HTTP status: `400` for the caller's mistakes, `401` for a failed
    /// client authentication, `500` for the server's own failure.
    pub status: StatusCode,
    /// The RFC 6749 §5.2 body: `error` and an optional `error_description`.
    pub error: OAuthError,
}

impl OAuthErrorResponse {
    /// The response at `status` with the `error` code and an optional
    /// human-readable `description`.
    pub fn new(status: StatusCode, error: OAuthErrorCode, description: Option<&str>) -> Self {
        Self {
            status,
            error: OAuthError::new(error, description),
        }
    }

    /// A `server_error` 500 carrying the RFC 6749 §5.2 body — the shape every
    /// "the server failed mid-flow" OAuth response shares. Shared so a surface
    /// like the authorize-status poll (which mixes `AuthorizationServerError` with a
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

/// Error half of the token / device-authorization / revocation endpoints' `Result`-returning
/// handlers (the OAuth-surface analogue of the Owner `/authorization` surface's
/// [`AuthorizationServerError`](crate::domain::authorization_server_error::AuthorizationServerError)). Every
/// variant renders the matching RFC 6749 §5.2 response, cache-suppressed per
/// §5.1, through `IntoResponse` — so a fallible step bails with `?` instead of
/// a `match` + `return` at each call site. Kept small (no embedded `Response`)
/// so `Result<_, TokenError>` doesn't trip `clippy::result_large_err`.
///
/// It is also the [`TokenRequest`](super::token_request::TokenRequest)
/// extractor's rejection. Beyond the constructors, the rest come by
/// conversion: a credential error and an authentication failure keep their
/// own rendering, a store failure becomes the logged opaque 500, and a failed
/// exchange maps onto RFC 6749 §5.2 and RFC 8628 §3.5.
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
/// [`Infrastructure`](crate::domain::authorization_server_error::AuthorizationServerError::Infrastructure)
/// variant here — becomes the logged, cache-suppressed opaque 500. This `From`
/// is what lets the exchange helpers `?` a `Result<_, AuthorizationServerError>` from
/// a domain action.
impl From<crate::domain::authorization_server_error::AuthorizationServerError> for TokenError {
    fn from(error: crate::domain::authorization_server_error::AuthorizationServerError) -> Self {
        TokenError::Internal(InternalError::new(
            "store operation failed on the token surface",
            error,
        ))
    }
}

/// Render the exchange flows' failure vocabulary onto RFC 6749 §5.2 / RFC 8628
/// §3.5:
///
/// - `UnauthorizedGrantType`: `400 unauthorized_client`, "Client may not use
///   this grant type";
/// - `InvalidCodeVerifier`: `400 invalid_grant`, "Invalid code_verifier
///   parameter";
/// - `InvalidRedirectUri`: `400 invalid_request`, "Invalid redirect_uri
///   parameter";
/// - `InvalidGrant(reason)`: `400 invalid_grant`, one description per family
///   of reasons (below), the reason itself logged;
/// - `ExpiredToken`, `AuthorizationPending`, `AccessDenied`, `SlowDown`: `400`
///   with the matching RFC 8628 §3.5 code and no description;
/// - `Issuance`: `500 server_error`, "Failed to sign JWT" when signing failed,
///   "No JSON Web Keys available to sign token" otherwise;
/// - `Store`: the logged, opaque 500.
///
/// The [`InvalidGrant`](TokenExchangeError::InvalidGrant) reasons collapse
/// onto a few descriptions: one for every code refusal — distinguishing "wrong
/// client" from "wrong redirect_uri" from "expired" from "bad verifier" would
/// leak facts about a code that may belong to another client — two for a device
/// code (unknown, already redeemed) and three for a refresh token (invalid,
/// expired, revoked). The specific reason is logged (it carries no secrets) so
/// the operator can still tell them apart.
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
                    AccessTokenIssuanceError::NoActiveSigningKey
                    | AccessTokenIssuanceError::Store(_) => {
                        "No JSON Web Keys available to sign token"
                    }
                    AccessTokenIssuanceError::Signing(_) => "Failed to sign JWT",
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
        InvalidGrantReason::RefreshTokenReplayed { .. }
        | InvalidGrantReason::RefreshTokenSessionRevoked { .. }
        | InvalidGrantReason::RefreshTokenClientRevoked { .. } => "Refresh token has been revoked",
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
    /// Which check refused the client, or the server-side failure that kept
    /// it from being checked.
    pub error: ClientAuthenticationError,
    /// How the client presented its credentials: a Basic attempt's `401`
    /// carries the challenge, a body attempt's doesn't.
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
