use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::Duration;
use serde::{Deserialize, Serialize};
use url::Url;

use super::client_auth::{
    ClientAuthenticationMethod, ClientCredentials, ResolveClientCredentialsError,
    BASIC_AUTH_CHALLENGE,
};
use crate::crypto_util::client_secret::verify_client_secret;
use crate::db_utils::GatekeeperStore;
use crate::domain::client::{Client, ClientKind};
use crate::domain::token::{mint_access_token, NewJwtArgs};
use crate::http::response_templates;

/// Lifetime of access tokens minted by the gatekeeper.
pub const ACCESS_TOKEN_TTL: Duration = Duration::hours(1);

/// Absolute lifetime of a refresh-token family, measured from the original
/// authorization. Rotation swaps generations but never extends this
/// deadline — past it the client re-runs the authorization flow.
pub const REFRESH_TOKEN_FAMILY_TTL: Duration = Duration::days(90);

/// Scope that opts a grant into refresh-token issuance (SMART on FHIR's
/// `offline_access` convention). Without it `/token` responses carry no
/// `refresh_token`.
pub const OFFLINE_ACCESS_SCOPE: &str = "offline_access";

/// Minimum polling interval the device-code flow enforces (RFC 8628 §3.5).
pub const DEVICE_CODE_POLL_INTERVAL: Duration = Duration::seconds(5);

/// Wrapper that stamps the RFC 6749 §5.1/§5.2 cache-suppression headers
/// (`Cache-Control: no-store`, `Pragma: no-cache`) onto the wrapped response.
/// Token- and device-authorization-endpoint responses — success or error —
/// must never be cached; wrapping makes that part of the value instead of a
/// step a call site can forget.
pub struct CacheSuppressed<T>(pub T);

impl<T: IntoResponse> IntoResponse for CacheSuppressed<T> {
    fn into_response(self) -> Response {
        (
            [
                (header::CACHE_CONTROL, "no-store"),
                (header::PRAGMA, "no-cache"),
            ],
            self.0,
        )
            .into_response()
    }
}

/// A cache-suppressed (`no-store`) 500 wrapping an internal error — the
/// token / device-authorization endpoints' standard server-failure response.
/// Centralised so a call site can't return one of those §5.1 responses
/// without the cache suppression those endpoints require.
pub fn cache_suppressed_internal_error(context: &str, err: impl std::fmt::Display) -> Response {
    CacheSuppressed(response_templates::internal_error(context, err)).into_response()
}

/// An [`OAuthError`] paired with the HTTP status it renders at — the
/// `(status, JSON body)` shape every OAuth-surface error response shares.
#[derive(Debug)]
pub struct OAuthErrorResponse {
    pub status: StatusCode,
    pub error: OAuthError,
}

impl OAuthErrorResponse {
    pub fn new(status: StatusCode, error: &str, description: Option<&str>) -> Self {
        Self {
            status,
            error: OAuthError::new(error, description),
        }
    }
}

impl IntoResponse for OAuthErrorResponse {
    fn into_response(self) -> Response {
        (self.status, Json(self.error)).into_response()
    }
}

/// RFC 6749 §5.1 successful token-endpoint response.
#[derive(Debug, Serialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub token_type: String,
    pub expires_in: i64,
    pub scope: String,
    /// Present only when the grant carries [`OFFLINE_ACCESS_SCOPE`] — the
    /// plaintext of the freshly-minted refresh-token generation (RFC 6749
    /// §5.1; only its hash is persisted).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patient: Option<String>,
}

impl IntoResponse for TokenResponse {
    /// RFC 6749 §5.1: a token response MUST carry `Cache-Control: no-store` —
    /// rendering through [`CacheSuppressed`] makes that unforgettable.
    fn into_response(self) -> Response {
        CacheSuppressed(Json(self)).into_response()
    }
}

/// RFC 6749 §5.2 token-endpoint error body.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OAuthError {
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_description: Option<String>,
}

impl OAuthError {
    pub fn new(error: &str, description: Option<&str>) -> Self {
        Self {
            error: error.to_string(),
            error_description: description.map(str::to_string),
        }
    }
}

/// Error half of the token / device-authorization endpoints' `Result`-returning
/// handlers (the OAuth-surface analogue of
/// [`HandlerError`](crate::http::response_templates::HandlerError)). Every
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
    ClientAuth(ValidateClientError),
    /// A logged, opaque, cache-suppressed 500 (e.g. a store read failed).
    Internal {
        context: &'static str,
        source: String,
    },
}

impl TokenError {
    /// A 400 OAuth error: the `error` code plus an optional human-readable
    /// `description` (RFC 6749 §5.2).
    pub fn bad_request(error: &str, description: Option<&str>) -> Self {
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
        TokenError::Internal {
            context,
            source: source.to_string(),
        }
    }
}

impl From<ResolveClientCredentialsError> for TokenError {
    fn from(error: ResolveClientCredentialsError) -> Self {
        TokenError::ResolveCredentials(error)
    }
}

impl From<ValidateClientError> for TokenError {
    fn from(error: ValidateClientError) -> Self {
        TokenError::ClientAuth(error)
    }
}

impl IntoResponse for TokenError {
    fn into_response(self) -> Response {
        match self {
            TokenError::Oauth(response) => CacheSuppressed(response).into_response(),
            TokenError::ResolveCredentials(error) => CacheSuppressed(error).into_response(),
            TokenError::ClientAuth(error) => CacheSuppressed(error).into_response(),
            TokenError::Internal { context, source } => {
                cache_suppressed_internal_error(context, source)
            }
        }
    }
}

/// Build the URL that closes the authorization-code flow by redirecting the
/// user-agent back to the client's already-parsed `redirect_uri` with `code`
/// and `state` appended.
pub fn build_client_redirect_url(redirect_uri: &Url, code: &str, client_state: &str) -> String {
    let mut url = redirect_uri.clone();
    url.query_pairs_mut()
        .append_pair("code", code)
        .append_pair("state", client_state);
    url.to_string()
}

/// Build the URL that closes the authorization-code flow with a failure by
/// redirecting the user-agent back to the client's already-parsed
/// `redirect_uri` with `error` and `state` appended (RFC 6749 §4.1.2.1).
pub fn build_client_error_redirect_url(
    redirect_uri: &Url,
    error: &str,
    client_state: &str,
) -> String {
    let mut url = redirect_uri.clone();
    url.query_pairs_mut()
        .append_pair("error", error)
        .append_pair("state", client_state);
    url.to_string()
}

/// Reasons that client authentication at the token endpoint can fail.
#[derive(Debug)]
pub enum ValidateClientError {
    /// Client identification or secret check failed — surface as 401. RFC
    /// 6749 §5.2: the response to a Basic-authentication attempt carries a
    /// matching `WWW-Authenticate: Basic` challenge.
    Unauthorized {
        error: OAuthError,
        attempted_via: ClientAuthenticationMethod,
    },
    /// Server-side failure (e.g. database read) — surface as 500.
    Internal(OAuthError),
}

impl IntoResponse for ValidateClientError {
    fn into_response(self) -> Response {
        match self {
            ValidateClientError::Unauthorized {
                error,
                attempted_via: ClientAuthenticationMethod::HttpBasic,
            } => (
                [(header::WWW_AUTHENTICATE, BASIC_AUTH_CHALLENGE)],
                OAuthErrorResponse {
                    status: StatusCode::UNAUTHORIZED,
                    error,
                },
            )
                .into_response(),
            ValidateClientError::Unauthorized {
                error,
                attempted_via: ClientAuthenticationMethod::RequestBody,
            } => OAuthErrorResponse {
                status: StatusCode::UNAUTHORIZED,
                error,
            }
            .into_response(),
            ValidateClientError::Internal(error) => OAuthErrorResponse {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                error,
            }
            .into_response(),
        }
    }
}

/// Look up the client named by the resolved credentials and authenticate it.
/// For confidential clients the presented secret is verified against the
/// stored argon2id PHC string (constant-time internally). Returns the loaded
/// `Client` if both checks pass.
pub fn require_valid_client_for_token(
    store: &GatekeeperStore,
    presented_credentials: &ClientCredentials,
) -> Result<Client, ValidateClientError> {
    // Every authentication failure records how the client authenticated, so
    // 401s answer Basic attempts with a matching `WWW-Authenticate` header
    // (RFC 6749 §5.2).
    let unauthorized = |description: &str| ValidateClientError::Unauthorized {
        error: OAuthError::new("invalid_client", Some(description)),
        attempted_via: presented_credentials.presented_via,
    };
    let client = store
        .client_by_id(&presented_credentials.client_id)
        .map_err(|e| {
            tracing::error!(error = %e, "client_by_id lookup failed");
            ValidateClientError::Internal(OAuthError::new("server_error", None))
        })?;
    let client = client.ok_or_else(|| unauthorized("Unknown client_id"))?;
    if client.disabled_at.is_some() {
        return Err(unauthorized("Client is disabled"));
    }
    if matches!(client.kind, ClientKind::Public) {
        return Ok(client);
    }
    let stored_hash = client
        .secret_hash
        .as_deref()
        .ok_or_else(|| unauthorized("Client secret not configured"))?;
    let presented = presented_credentials
        .client_secret
        .as_deref()
        .ok_or_else(|| unauthorized("Client secret required"))?;
    let secret_matches = verify_client_secret(presented, stored_hash).map_err(|e| {
        tracing::error!(error = %e, "client secret verification failed");
        ValidateClientError::Internal(OAuthError::new("server_error", None))
    })?;
    if !secret_matches {
        return Err(unauthorized("Invalid client_secret"));
    }
    Ok(client)
}

/// Inputs required to mint and frame an OAuth `TokenResponse`.
pub struct IssueTokenInput<'a> {
    /// Client the token is being issued to.
    pub client_id: &'a str,
    /// Scopes granted by the user (or the host) during authorization.
    pub granted_scopes: &'a [String],
    /// SMART-on-FHIR patient context, if any.
    pub patient: Option<&'a str>,
    /// Origin minting the token — used for the `iss` and (with `/fhir-r4`) the
    /// `aud` claims.
    pub origin: &'a str,
}

/// Mint a signed JWT for `input` and wrap it in a `TokenResponse`. Returns
/// `OAuthError("server_error", ...)` if no signing key is available or the
/// JWS encode fails.
pub fn issue_token_response(
    store: &GatekeeperStore,
    input: &IssueTokenInput<'_>,
) -> Result<TokenResponse, OAuthError> {
    let signing_key = store
        .active_signing_key()
        .map_err(|e| {
            tracing::error!(error = %e, "active_signing_key lookup failed");
            OAuthError::new(
                "server_error",
                Some("No JSON Web Keys available to sign token"),
            )
        })?
        .ok_or_else(|| {
            OAuthError::new(
                "server_error",
                Some("No JSON Web Keys available to sign token"),
            )
        })?;
    let audience = format!("{}/fhir-r4", input.origin);
    let signed = mint_access_token(
        &signing_key,
        &NewJwtArgs {
            client_id: input.client_id,
            scope: input.granted_scopes,
            ttl: ACCESS_TOKEN_TTL,
            origin: input.origin,
            audience: Some(&audience),
            patient: input.patient,
        },
    )
    .map_err(|e| {
        tracing::error!(error = %e, "mint_access_token failed");
        OAuthError::new("server_error", Some("Failed to sign JWT"))
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
