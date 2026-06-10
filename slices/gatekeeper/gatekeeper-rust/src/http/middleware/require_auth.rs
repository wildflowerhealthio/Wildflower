use axum::body::Body;
use axum::extract::{Extension, Request};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::sync::Arc;

use crate::domain::token::{verify_jwt, VerifiedClaims, VerifyError, VerifyOptions};
use crate::http::state::AppState;
use crate::OWNER_SCOPE;

#[derive(Clone)]
pub struct AuthedClaims(pub Arc<VerifiedClaims>);

pub async fn require_owner_auth(
    Extension(state): Extension<AppState>,
    headers: HeaderMap,
    mut req: Request<Body>,
    next: Next,
) -> Response {
    let token = match bearer_token(&headers) {
        Some(t) => t,
        None => return unauthorized(),
    };
    let claims = match verify_owner_token(&state, &headers, &token) {
        Ok(c) => c,
        Err(VerifyError::NoSigningKeysConfigured) => return internal_error(),
        Err(_) => return unauthorized(),
    };
    req.extensions_mut().insert(AuthedClaims(Arc::new(claims)));
    next.run(req).await
}

pub fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let value = headers.get("authorization")?.to_str().ok()?;
    let lower = value.to_ascii_lowercase();
    let prefix = "bearer ";
    if !lower.starts_with(prefix) {
        return None;
    }
    Some(value[prefix.len()..].trim().to_string())
}

pub fn verify_owner_token(
    state: &AppState,
    headers: &HeaderMap,
    token: &str,
) -> Result<VerifiedClaims, VerifyError> {
    let claims = verify_any_token(state, headers, token)?;
    let scopes = claims
        .scope
        .as_deref()
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>();
    if !scopes.contains(&OWNER_SCOPE) {
        return Err(VerifyError::TokenRejected);
    }
    Ok(claims)
}

pub fn verify_any_token(
    state: &AppState,
    headers: &HeaderMap,
    token: &str,
) -> Result<VerifiedClaims, VerifyError> {
    let keys = state
        .store
        .all_signing_keys()
        .map_err(|_| VerifyError::SigningKeyUnreadable)?;
    let origin = state.origin.origin_for(headers);
    let accepted = vec![format!("{origin}/fhir-r4"), origin.clone()];
    verify_jwt(
        token,
        &keys,
        VerifyOptions {
            expected_issuer: &origin,
            accepted_audiences: &accepted,
        },
    )
}

fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
}

fn internal_error() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, "internal_server_error").into_response()
}
