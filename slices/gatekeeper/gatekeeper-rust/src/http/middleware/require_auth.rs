use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap};
use axum::middleware::Next;
use axum::response::Response;

use crate::domain::token::{verify_jwt, VerifiedClaims, VerifyError, VerifyOptions};
use crate::http::response_templates;
use crate::http::served_origin_for;
use crate::http::state::AppState;
use crate::OWNER_SCOPE;

pub async fn require_owner_auth(
    State(state): State<AppState>,
    headers: HeaderMap,
    req: Request<Body>,
    next: Next,
) -> Response {
    let Some(token) = try_bearer_token_from_headers(&headers) else {
        return response_templates::unauthorized();
    };
    // Verify against the origin the request says it was targeting — loopback
    // for a direct hit, the public origin when forwarded by the tunnel — so a
    // token's `iss`/`aud` are checked against the same surface it was minted
    // for. `loopback_origin` is the fallback for un-forwarded requests.
    let origin = served_origin_for(&headers, &state.loopback_origin);
    if let Err(e) = verify_owner_token(&state, &origin, &token) {
        return response_templates::verify_error_response("verify_owner_token failed", e);
    }
    next.run(req).await
}

pub fn try_bearer_token_from_headers(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
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
    origin: &str,
    token: &str,
) -> Result<VerifiedClaims, VerifyError> {
    let claims = verify_auth_token_claims(state, origin, token)?;
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

pub fn verify_auth_token_claims(
    state: &AppState,
    origin: &str,
    token: &str,
) -> Result<VerifiedClaims, VerifyError> {
    let keys = state
        .store
        .all_signing_keys()
        .map_err(VerifyError::KeyStoreUnavailable)?;
    let accepted = vec![format!("{origin}/fhir-r4"), origin.to_string()];
    // `iss` is the stable [`shared_structures_rust::CANONICAL_ISSUER`] — same
    // value gatekeeper writes into every minted token. `aud` is per-request:
    // a token minted for one surface (loopback vs tunnel) is only accepted
    // when presented to the surface it was scoped for.
    verify_jwt(
        token,
        &keys,
        &VerifyOptions {
            expected_issuer: shared_structures_rust::CANONICAL_ISSUER,
            accepted_audiences: &accepted,
        },
    )
}
