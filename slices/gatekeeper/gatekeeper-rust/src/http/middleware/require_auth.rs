use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap};
use axum::middleware::Next;
use axum::response::Response;

use crate::domain::token::VerifiedClaims;
use crate::http::errors;
use crate::http::served_base_url_for;
use crate::http::state::GatekeeperState;
use crate::live_bindings::{FromState, LiveTokenVerifier};

/// The `/access` authN gate: verify the request carries a **valid, non-revoked**
/// bearer (or `wf_auth` cookie) token and stash the resulting [`VerifiedClaims`]
/// in the request's extensions for the scope-gated capability extractors
/// (`domain::capabilities`) to read — a missing/invalid token is a `401`.
///
/// This replaces the old blanket owner gate: authorization is no longer
/// all-or-nothing here. This layer only proves *who* the caller is (authN);
/// *what* they may do (authZ) is decided per-route by the `Scoped<…>` extractor,
/// which reads these claims and checks the covering scope, returning a `403`
/// with the missing scopes on failure. An owner token (covering
/// [`WILDFLOWER_WIDEST_SCOPES`](crate::WILDFLOWER_WIDEST_SCOPES)) still covers
/// every per-resource scope, so it passes every gate exactly as before.
///
/// This is one of the **pair** of claims-inserting authN gates (see
/// `docs/Authorization/Scope-Gated Endpoints How-To.md`, "Wiring the claims"):
/// this one guards gatekeeper's own `/access` router and inserts the domain
/// [`VerifiedClaims`]; its sibling
/// [`require_valid_bearer_token`](super::require_valid_bearer_token::require_valid_bearer_token)
/// wraps the host's downstream slice routers and inserts the framework-neutral
/// `ScopeClaims`. Both run the same [`verify_request_claims`] pipeline.
pub async fn require_valid_session(
    State(state): State<Arc<GatekeeperState>>,
    headers: HeaderMap,
    mut req: Request<Body>,
    next: Next,
) -> Response {
    let claims = match verify_request_claims(&state, &headers, "require_valid_session failed") {
        Ok((claims, _source)) => claims,
        Err(response) => return *response,
    };
    // Hand the verified claims (incl. the `scope` claim) to the handler layer.
    // The scope-gated extractors read them from here rather than re-verifying —
    // authN runs exactly once, at this layer.
    req.extensions_mut().insert(claims);
    next.run(req).await
}

/// The shared authN pipeline both claims-inserting gates run: extract the access
/// token (bearer header or `wf_auth` cookie), resolve the request's served
/// origin, verify the token against it through the
/// [`TokenVerifier`](crate::domain::capabilities::session::TokenVerifier)
/// (signature, issuer/audience, revocation), and map each failure to its
/// response — a missing token is a `401`, an
/// unresolvable origin a `500`, a verify failure whatever
/// [`errors::verify_error_response`] maps it to. Extracted so
/// [`require_valid_session`] and
/// [`require_valid_bearer_token`](super::require_valid_bearer_token::require_valid_bearer_token)
/// cannot drift in how a token becomes claims; they differ only in the extension
/// type they insert (and the bearer gate's exempt paths + cookie normalization).
///
/// Returns the claims plus the raw token and its [`AccessTokenSource`] (the
/// bearer gate re-presents a cookie-sourced token as a bearer header
/// downstream). The error is the prepared failure `Response`, boxed so the
/// happy-path `Ok` stays small (the `Response` is large — `clippy::result_large_err`).
pub(crate) fn verify_request_claims<'h>(
    state: &Arc<GatekeeperState>,
    headers: &'h HeaderMap,
    log_context: &'static str,
) -> Result<(VerifiedClaims, (&'h str, AccessTokenSource)), Box<Response>> {
    let Some((token, source)) = try_access_token_from_request(headers) else {
        return Err(Box::new(errors::unauthorized()));
    };
    // Verify against the request's served origin (loopback for a direct hit,
    // the forwarded public origin via the tunnel) so the token's `iss`/`aud`
    // match the surface it was minted for. See `docs/Origins/Explanation.md`.
    let Some(base_url) = served_base_url_for(headers, &state.loopback_base_url) else {
        return Err(Box::new(errors::internal_error(
            "served base url",
            "forwarded header did not indicate a valid base URL",
        )));
    };
    let origin = shared_structures_rust::origin_string(&base_url);
    let claims = LiveTokenVerifier::from_state(state)
        .verify(&origin, token)
        .map_err(|e| Box::new(errors::verify_error_response(log_context, e)))?;
    Ok((claims, (token, source)))
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
/// Bearer` header and falling back to the [`wf_auth`](crate::cookies)
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
    let cookie = crate::cookies::cookie_value(headers, crate::cookies::AUTH_COOKIE_NAME)
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
