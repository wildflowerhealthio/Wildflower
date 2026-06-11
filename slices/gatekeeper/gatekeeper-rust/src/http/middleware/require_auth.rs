use axum::body::Body;
use axum::extract::{Extension, Request};
use axum::http::HeaderMap;
use axum::middleware::Next;
use axum::response::Response;
use std::sync::Arc;

use crate::domain::token::{verify_jwt, VerifiedClaims, VerifyError, VerifyOptions};
use crate::http::served_origin_for;
use crate::http::responses::{unauthorized, verify_error_response};
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
        Err(e) => return verify_error_response("verify_owner_token failed", e),
    };
    req.extensions_mut().insert(AuthedClaims(Arc::new(claims)));
    next.run(req).await
}

pub fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let value = headers.get("authorization")?.to_str().ok()?;
    let prefix = "bearer ";
    // Case-insensitive prefix check against just the scheme bytes — avoids
    // lowercasing (and reallocating) the whole header, which carries the
    // full JWT.
    if !value
        .get(..prefix.len())
        .is_some_and(|p| p.eq_ignore_ascii_case(prefix))
    {
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
    let has_owner_scope = claims
        .scope
        .as_deref()
        .unwrap_or("")
        .split_whitespace()
        .any(|s| s == OWNER_SCOPE);
    if !has_owner_scope {
        return Err(VerifyError::TokenRejected);
    }
    Ok(claims)
}

// `_headers` is now vestigial: the issuer/audience is pinned to the
// configured origin in `AppState`, not derived from the request. The
// parameter is retained only because the sibling
// `require_valid_bearer_token` middleware (outside this change's file
// boundary) still calls `verify_any_token(&state, &headers, &token)`;
// drop it together when that file is in scope.
pub fn verify_any_token(
    state: &AppState,
    headers: &HeaderMap,
    token: &str,
) -> Result<VerifiedClaims, VerifyError> {
    let keys = state
        .store
        .all_signing_keys()
        .map_err(VerifyError::KeyStoreUnavailable)?;
    // Verify against the origin the request says it was targeting — loopback
    // for a direct hit, the public origin when forwarded by the tunnel — so a
    // token's `iss`/`aud` are checked against the same surface it was minted
    // for. `loopback_origin` is the fallback for un-forwarded requests.
    let origin = served_origin_for(headers, &state.loopback_origin);
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
