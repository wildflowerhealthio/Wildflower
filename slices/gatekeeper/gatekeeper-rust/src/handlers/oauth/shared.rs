use serde::{Deserialize, Serialize};
use url::Url;

use crate::crypto::jwt::{mint_access_token, MintArgs};
use crate::crypto::pkce::sha256_hex;
use crate::crypto::timing_safe::timing_safe_eq;
use crate::store::client::{ClientKind, ClientRow};
use crate::store::GatekeeperStore;

pub const ACCESS_TOKEN_TTL_SECS: i64 = 60 * 60;
pub const DEVICE_CODE_POLL_INTERVAL_SECS: i64 = 5;

#[derive(Debug, Serialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub token_type: String,
    pub expires_in: i64,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patient: Option<String>,
}

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

pub fn build_client_redirect_url(
    redirect_uri: &str,
    code: &str,
    client_state: &str,
) -> String {
    let mut url = Url::parse(redirect_uri).expect("redirect_uri parsed before");
    url.query_pairs_mut()
        .append_pair("code", code)
        .append_pair("state", client_state);
    url.to_string()
}

#[derive(Debug)]
pub enum ValidateClientError {
    Unauthorized(OAuthError),
    Internal(OAuthError),
}

pub fn require_valid_client_for_token(
    store: &GatekeeperStore,
    client_id: &str,
    client_secret: Option<&str>,
) -> Result<ClientRow, ValidateClientError> {
    let client = store
        .client_by_id(client_id)
        .map_err(|_| ValidateClientError::Internal(OAuthError::new("server_error", None)))?;
    let client = match client {
        Some(c) => c,
        None => {
            return Err(ValidateClientError::Unauthorized(OAuthError::new(
                "invalid_client",
                Some("Unknown client_id"),
            )))
        }
    };
    if client.disabled_at.is_some() {
        return Err(ValidateClientError::Unauthorized(OAuthError::new(
            "invalid_client",
            Some("Client is disabled"),
        )));
    }
    if matches!(client.kind, ClientKind::Public) {
        return Ok(client);
    }
    let stored_hash = match client.secret_hash.as_deref() {
        Some(h) => h,
        None => {
            return Err(ValidateClientError::Unauthorized(OAuthError::new(
                "invalid_client",
                Some("Client secret not configured"),
            )))
        }
    };
    let presented = match client_secret {
        Some(s) => s,
        None => {
            return Err(ValidateClientError::Unauthorized(OAuthError::new(
                "invalid_client",
                Some("Client secret required"),
            )))
        }
    };
    let presented_hash = sha256_hex(presented);
    if !timing_safe_eq(&presented_hash, stored_hash) {
        return Err(ValidateClientError::Unauthorized(OAuthError::new(
            "invalid_client",
            Some("Invalid client_secret"),
        )));
    }
    Ok(client)
}

pub struct IssueTokenInput<'a> {
    pub client_id: &'a str,
    pub granted_scopes: &'a [String],
    pub patient: Option<&'a str>,
    pub origin: &'a str,
}

pub fn issue_token_response(
    store: &GatekeeperStore,
    input: IssueTokenInput<'_>,
) -> Result<TokenResponse, OAuthError> {
    let active = store
        .active_signing_key()
        .map_err(|_| OAuthError::new("server_error", Some("No JSON Web Keys available to sign token")))?;
    let key = match active {
        Some(k) => k,
        None => {
            let all = store.all_signing_keys().map_err(|_| {
                OAuthError::new("server_error", Some("No JSON Web Keys available to sign token"))
            })?;
            all.into_iter().next().ok_or_else(|| {
                OAuthError::new("server_error", Some("No JSON Web Keys available to sign token"))
            })?
        }
    };
    let audience = format!("{}/fhir-r4", input.origin);
    let signed = mint_access_token(
        &key,
        MintArgs {
            client_id: input.client_id,
            scope: input.granted_scopes,
            ttl_secs: ACCESS_TOKEN_TTL_SECS,
            origin: input.origin,
            audience: Some(&audience),
            patient: input.patient,
        },
    )
    .map_err(|_| OAuthError::new("server_error", Some("Failed to sign JWT")))?;
    Ok(TokenResponse {
        access_token: signed,
        token_type: "Bearer".to_string(),
        expires_in: ACCESS_TOKEN_TTL_SECS,
        scope: input.granted_scopes.join(" "),
        patient: input.patient.map(str::to_string),
    })
}
