use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use url::Url;

use super::client_auth::{
    ClientAuthenticationMethod, ClientCredentials, ResolveClientCredentialsError,
    BASIC_AUTH_CHALLENGE,
};
use crate::crypto_util::client_secret::verify_client_secret;
use crate::db::GatekeeperStore;
use crate::domain::client::{Client, ClientKind};
use crate::domain::oauth_error_code::OAuthErrorCode;
use crate::domain::token::{mint_access_token, NewJwtArgs, ACCESS_TOKEN_TTL};
use crate::http::response_templates::InternalError;
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
    /// like the Owner-UI polling page (which mixes `HandlerError` with a
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
            TokenError::Internal(error) => CacheSuppressed(error).into_response(),
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
    error: OAuthErrorCode,
    client_state: &str,
) -> String {
    let mut url = redirect_uri.clone();
    url.query_pairs_mut()
        .append_pair("error", error.as_ref())
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
        error: OAuthError::new(OAuthErrorCode::InvalidClient, Some(description)),
        attempted_via: presented_credentials.presented_via,
    };
    let client = store
        .client_by_id(&presented_credentials.client_id)
        .map_err(|e| {
            tracing::error!(error = %e, "client_by_id lookup failed");
            ValidateClientError::Internal(OAuthError::new(OAuthErrorCode::ServerError, None))
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
        ValidateClientError::Internal(OAuthError::new(OAuthErrorCode::ServerError, None))
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
    /// Origin minting the token — feeds **only** the `aud` claim
    /// (`{origin}/fhir-r4`). `iss` is always
    /// [`shared_structures_rust::CANONICAL_ISSUER`], independent of `origin`.
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
