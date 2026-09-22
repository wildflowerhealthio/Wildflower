use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;

use super::client_auth::{
    ClientAuthenticationMethod, ResolveClientCredentialsError, BASIC_AUTH_CHALLENGE,
};
use crate::domain::authority::ClientAuthenticationError;
use crate::domain::oauth_error_code::OAuthErrorCode;
use crate::domain::token::{mint_access_token, NewJwtArgs, ACCESS_TOKEN_TTL};
use crate::domain::GatekeeperStore;
use crate::http::errors::InternalError;
use crate::http::wire_representations::{CacheSuppressed, OAuthError, TokenResponse};

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
    pub attempted_via: ClientAuthenticationMethod,
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
        match self.attempted_via {
            ClientAuthenticationMethod::HttpBasic => (
                [(header::WWW_AUTHENTICATE, BASIC_AUTH_CHALLENGE)],
                unauthorized,
            )
                .into_response(),
            ClientAuthenticationMethod::RequestBody => unauthorized.into_response(),
        }
    }
}

/// Inputs required to mint and frame an OAuth `TokenResponse`.
pub struct IssueTokenInput<'a> {
    /// Client the token is being issued to.
    pub client_id: &'a str,
    /// Scopes granted by the user (or the host) during authorization.
    pub granted_scopes: &'a [String],
    /// SMART-on-FHIR patient context, if any.
    pub patient: Option<&'a str>,
    /// Origin minting the token — feeds **only** the `aud` claim
    /// (`{origin}/fhir-r4`). `iss` is always
    /// [`shared_structures_rust::CANONICAL_ISSUER`], independent of `origin`.
    pub origin: &'a str,
}

/// Mint a signed JWT for `input` and wrap it in a `TokenResponse`. Returns
/// `OAuthError("server_error", ...)` if no signing key is available or the
/// JWS encode fails.
pub fn issue_token_response(
    store: &impl GatekeeperStore,
    input: &IssueTokenInput<'_>,
) -> Result<TokenResponse, OAuthError> {
    let signing_key = store
        .active_signing_key()
        .map_err(|e| {
            tracing::error!(error = %e, "active_signing_key lookup failed");
            OAuthError::new(
                OAuthErrorCode::ServerError,
                Some("No JSON Web Keys available to sign token"),
            )
        })?
        .ok_or_else(|| {
            OAuthError::new(
                OAuthErrorCode::ServerError,
                Some("No JSON Web Keys available to sign token"),
            )
        })?;
    // `iss` is the fixed [`shared_structures_rust::CANONICAL_ISSUER`]; `aud` is
    // this request's origin. See `docs/Origins/Explanation.md`.
    let audience = format!("{}/fhir-r4", input.origin);
    // Mint each granted scope alongside its alternate canonical form, so a
    // v1-worded grant also carries its v2 letter spelling — see
    // [`scopes_rust::with_alternate_canonical_forms`] and scopes-rust's
    // `Permission` for why. The app-facing `TokenResponse.scope` below stays
    // the granted set as-is.
    let token_scopes = scopes_rust::with_alternate_canonical_forms(input.granted_scopes);
    let signed = mint_access_token(
        &signing_key,
        &NewJwtArgs {
            client_id: input.client_id,
            scope: &token_scopes,
            ttl: ACCESS_TOKEN_TTL,
            origin: shared_structures_rust::CANONICAL_ISSUER,
            audience: Some(&audience),
            patient: input.patient,
            // OAuth-minted tokens carry a served-origin `aud`, never the
            // canonical audience — so they are never the host owner token.
            is_host_owner: false,
        },
    )
    .map_err(|e| {
        tracing::error!(error = %e, "mint_access_token failed");
        OAuthError::new(OAuthErrorCode::ServerError, Some("Failed to sign JWT"))
    })?;
    Ok(TokenResponse {
        access_token: signed,
        token_type: "Bearer".to_string(),
        expires_in: ACCESS_TOKEN_TTL.num_seconds(),
        scope: input.granted_scopes.join(" "),
        refresh_token: None,
        patient: input.patient.map(str::to_string),
    })
}
