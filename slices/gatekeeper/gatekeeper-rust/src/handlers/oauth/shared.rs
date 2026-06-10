use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::Duration;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::crypto::jwt::{mint_access_token, NewJwtArgs};
use crate::crypto::pkce::sha256_hex;
use crate::crypto::timing_safe::timing_safe_eq;
use crate::store::client::{Client, ClientKind};
use crate::store::GatekeeperStore;

/// Lifetime of access tokens minted by the gatekeeper.
pub const ACCESS_TOKEN_TTL: Duration = Duration::hours(1);

/// Minimum polling interval the device-code flow enforces (RFC 8628 §3.5).
pub const DEVICE_CODE_POLL_INTERVAL: Duration = Duration::seconds(5);

/// RFC 6749 §5.1 successful token-endpoint response.
#[derive(Debug, Serialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub token_type: String,
    pub expires_in: i64,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patient: Option<String>,
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

/// Reasons that client authentication at the token endpoint can fail.
#[derive(Debug)]
pub enum ValidateClientError {
    /// Client identification or secret check failed — surface as 401.
    Unauthorized(OAuthError),
    /// Server-side failure (e.g. database read) — surface as 500.
    Internal(OAuthError),
}

impl IntoResponse for ValidateClientError {
    fn into_response(self) -> Response {
        match self {
            ValidateClientError::Unauthorized(e) => {
                (StatusCode::UNAUTHORIZED, Json(e)).into_response()
            }
            ValidateClientError::Internal(e) => {
                (StatusCode::INTERNAL_SERVER_ERROR, Json(e)).into_response()
            }
        }
    }
}

/// Look up the client by `client_id` and authenticate it (timing-safe secret
/// comparison for confidential clients). Returns the loaded `Client` if both
/// checks pass.
pub fn require_valid_client_for_token(
    store: &GatekeeperStore,
    client_id: &str,
    client_secret: Option<&str>,
) -> Result<Client, ValidateClientError> {
    let client = store.client_by_id(client_id).map_err(|e| {
        tracing::error!(error = %e, "client_by_id lookup failed");
        ValidateClientError::Internal(OAuthError::new("server_error", None))
    })?;
    let client = client.ok_or_else(|| {
        ValidateClientError::Unauthorized(OAuthError::new(
            "invalid_client",
            Some("Unknown client_id"),
        ))
    })?;
    if client.disabled_at.is_some() {
        return Err(ValidateClientError::Unauthorized(OAuthError::new(
            "invalid_client",
            Some("Client is disabled"),
        )));
    }
    if matches!(client.kind, ClientKind::Public) {
        return Ok(client);
    }
    let stored_hash = client.secret_hash.as_deref().ok_or_else(|| {
        ValidateClientError::Unauthorized(OAuthError::new(
            "invalid_client",
            Some("Client secret not configured"),
        ))
    })?;
    let presented = client_secret.ok_or_else(|| {
        ValidateClientError::Unauthorized(OAuthError::new(
            "invalid_client",
            Some("Client secret required"),
        ))
    })?;
    if !timing_safe_eq(&sha256_hex(presented), stored_hash) {
        return Err(ValidateClientError::Unauthorized(OAuthError::new(
            "invalid_client",
            Some("Invalid client_secret"),
        )));
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
    input: IssueTokenInput<'_>,
) -> Result<TokenResponse, OAuthError> {
    let signing_key = store
        .active_signing_key()
        .map_err(|e| {
            tracing::error!(error = %e, "active_signing_key lookup failed");
            OAuthError::new("server_error", Some("No JSON Web Keys available to sign token"))
        })?
        .ok_or_else(|| {
            OAuthError::new("server_error", Some("No JSON Web Keys available to sign token"))
        })?;
    let audience = format!("{}/fhir-r4", input.origin);
    let signed = mint_access_token(
        &signing_key,
        NewJwtArgs {
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
        patient: input.patient.map(str::to_string),
    })
}
