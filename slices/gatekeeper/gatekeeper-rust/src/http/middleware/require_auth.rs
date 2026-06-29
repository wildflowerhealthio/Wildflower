use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap};
use axum::middleware::Next;
use axum::response::Response;

use crate::domain::token::{verify_jwt, VerifiedClaims, VerifyError, VerifyOptions};
use crate::http::response_templates;
use crate::http::served_origin_for;
use crate::http::state::AppState;
use crate::WILDFLOWER_WIDEST_SCOPES;
use scopes_rust::Scope;

pub async fn require_owner_auth(
    State(state): State<AppState>,
    headers: HeaderMap,
    req: Request<Body>,
    next: Next,
) -> Response {
    let Some(token) = try_bearer_token_from_headers(&headers) else {
        return response_templates::unauthorized();
    };
    // Verify against the request's served origin (loopback for a direct hit,
    // the forwarded public origin via the tunnel) so the token's `iss`/`aud`
    // match the surface it was minted for. See `docs/Origins/Explanation.md`.
    let origin = served_origin_for(
        &headers,
        &state.loopback_base_url.origin().ascii_serialization(),
    );
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
    // Owner = the token covers *every* maximal-access scope (full FHIR + full
    // Wildflower), which gates gatekeeper's `/access/*` admin surface — see
    // [`WILDFLOWER_WIDEST_SCOPES`](crate::WILDFLOWER_WIDEST_SCOPES).
    let token_claim_scopes: Vec<Scope> = claims
        .scope
        .as_deref()
        .unwrap_or("")
        .split_whitespace()
        .map(Scope::from)
        .collect();
    // Guard: an empty owner-defining set makes `all()` vacuously true, admitting
    // every token (even a scope-less one) to `/access/*`.
    debug_assert!(
        !WILDFLOWER_WIDEST_SCOPES.is_empty(),
        "WILDFLOWER_WIDEST_SCOPES must be non-empty or the owner check fails open"
    );
    let grants_owner = WILDFLOWER_WIDEST_SCOPES.iter().all(|mandatory_scope| {
        token_claim_scopes
            .iter()
            .any(|token_claim| token_claim.covers(mandatory_scope))
    });
    if !grants_owner {
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
    // `iss` must equal [`shared_structures_rust::CANONICAL_ISSUER`]; `aud` is
    // checked per-request against this origin (and its `/fhir-r4` base). See
    // `docs/Origins/Explanation.md`.
    verify_jwt(
        token,
        &keys,
        &VerifyOptions {
            expected_issuer: shared_structures_rust::CANONICAL_ISSUER,
            accepted_audiences: &accepted,
        },
    )
}
