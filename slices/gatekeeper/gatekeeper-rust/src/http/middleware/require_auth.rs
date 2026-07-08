use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap};
use axum::middleware::Next;
use axum::response::Response;

use crate::domain::token::{verify_jwt, VerifiedClaims, VerifyError, VerifyOptions};
use crate::http::response_templates;
use crate::http::served_base_url_for;
use crate::http::state::AppState;
use crate::WILDFLOWER_WIDEST_SCOPES;
use scopes_rust::Scope;

pub async fn require_owner_auth(
    State(state): State<AppState>,
    headers: HeaderMap,
    req: Request<Body>,
    next: Next,
) -> Response {
    let Some((token, _source)) = try_access_token_from_request(&headers) else {
        return response_templates::unauthorized();
    };
    // Verify against the request's served origin (loopback for a direct hit,
    // the forwarded public origin via the tunnel) so the token's `iss`/`aud`
    // match the surface it was minted for. See `docs/Origins/Explanation.md`.
    let Some(base_url) = served_base_url_for(&headers, &state.loopback_base_url) else {
        return response_templates::internal_error(
            "served base url",
            "forwarded header did not indicate a valid base URL",
        );
    };
    let origin = base_url.origin().ascii_serialization();
    if let Err(e) = verify_owner_token(&state, &origin, token) {
        return response_templates::verify_error_response("verify_owner_token failed", e);
    }
    next.run(req).await
}

/// Where a verified access token was extracted from. The FHIR bearer gate
/// carries this from extraction to injection so it only re-inserts an
/// `Authorization: Bearer` header for the cookie path — a bearer request already
/// carries one, so it skips the `format!` + parse entirely.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessTokenSource {
    /// An `Authorization: Bearer` header (already present downstream).
    Bearer,
    /// The `wf_auth` cookie — the web path, where no bearer header is present.
    Cookie,
}

/// Extract the access token from a request, preferring the `Authorization:
/// Bearer` header and falling back to the [`wf_auth`](crate::http::cookies)
/// cookie when no bearer header is present. Returns the token alongside its
/// [`AccessTokenSource`].
///
/// The bearer branch preserves the embedded (Tauri) path, which keeps attaching
/// the header from its JS-held token; the cookie branch serves the web path,
/// where the token is `HttpOnly` and invisible to JS (see #218). Verification
/// downstream is identical regardless of source — it verifies a token *string*.
/// An empty cookie value (e.g. a just-cleared `wf_auth=`) is treated as absent.
///
/// Both sources borrow straight out of `headers`, so a request pays no
/// per-request JWT copy on the way to verification.
pub fn try_access_token_from_request(headers: &HeaderMap) -> Option<(&str, AccessTokenSource)> {
    if let Some(bearer) = try_bearer_token_from_headers(headers) {
        return Some((bearer, AccessTokenSource::Bearer));
    }
    let cookie =
        crate::http::cookies::cookie_value(headers, crate::http::cookies::AUTH_COOKIE_NAME)
            .filter(|token| !token.is_empty())?;
    Some((cookie, AccessTokenSource::Cookie))
}

pub fn try_bearer_token_from_headers(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let prefix = "bearer ";
    // Case-insensitive prefix check against just the scheme bytes — avoids
    // lowercasing (and reallocating) the whole header, which carries the
    // full JWT. The returned slice borrows the header, so no copy is made.
    if !value
        .get(..prefix.len())
        .is_some_and(|p| p.eq_ignore_ascii_case(prefix))
    {
        return None;
    }
    Some(value[prefix.len()..].trim())
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
    let accepted = vec![
        format!("{origin}/fhir-r4"),
        origin.to_string(),
        // The host owner token's canonical audience: the host presents that
        // one token over loopback AND at the tunnel origin (the popup's
        // seeded `wf_auth` cookie, #256), so it can't carry a served-origin
        // `aud`. Accepting it here is gated by the `wf_owner` marker check
        // below, so this acceptance can't be borrowed by any other token.
        shared_structures_rust::CANONICAL_ISSUER.to_string(),
    ];
    // `iss` must equal [`shared_structures_rust::CANONICAL_ISSUER`]; `aud` is
    // checked per-request against this origin (and its `/fhir-r4` base), plus
    // the canonical audience. See `docs/Origins/Explanation.md`.
    let claims = verify_jwt(
        token,
        &keys,
        &VerifyOptions {
            expected_issuer: shared_structures_rust::CANONICAL_ISSUER,
            accepted_audiences: &accepted,
        },
    )?;
    // The canonical audience is accepted at *every* served origin, so it must
    // be reserved for the one token that legitimately needs it: the host owner
    // token, which carries the `wf_owner` marker. Any other token that reaches
    // us via the canonical audience — a future minting bug, a copied pattern, a
    // leaked-and-replayed token — is rejected here, restoring the per-origin
    // binding for every non-owner token. A token that matched a served-origin
    // `aud` never trips this. See `docs/Origins/Explanation.md`.
    let via_canonical_audience = claims
        .audience
        .iter()
        .any(|aud| aud == shared_structures_rust::CANONICAL_ISSUER);
    if via_canonical_audience && claims.host_owner != Some(true) {
        return Err(VerifyError::TokenRejected);
    }
    Ok(claims)
}
