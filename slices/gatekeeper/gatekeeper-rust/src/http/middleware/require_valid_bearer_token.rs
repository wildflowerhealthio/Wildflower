use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue};
use axum::middleware::Next;
use axum::response::Response;

use crate::http::response_templates;
use crate::http::served_origin_for;
use crate::http::state::AppState;

use crate::http::middleware::require_auth::{
    try_access_token_from_request, try_bearer_token_from_headers, verify_auth_token_claims,
};

/// State for [`require_valid_bearer_token`]: the gatekeeper [`AppState`] plus the
/// full request paths that skip the token check entirely. Built by
/// [`layer_router_with_gatekeeper_auth_gating`](crate::http::layer_router_with_gatekeeper_auth_gating).
#[derive(Clone)]
pub struct BearerGate {
    pub state: AppState,
    pub exempt: Arc<[String]>,
}

pub async fn require_valid_bearer_token(
    State(gate): State<BearerGate>,
    headers: HeaderMap,
    mut req: Request<Body>,
    next: Next,
) -> Response {
    // Exempt paths (the discovery docs fetched before a client holds a token)
    // bypass the bearer check, still behind the loopback-peer gate on the merged
    // `api_router`. See `docs/Origins/Explanation.md`.
    if is_exempt(req.uri().path(), &gate.exempt) {
        return next.run(req).await;
    }
    let Some(token) = try_access_token_from_request(&headers) else {
        return response_templates::unauthorized();
    };
    let origin = served_origin_for(
        &headers,
        &gate.state.loopback_base_url.origin().ascii_serialization(),
    );
    if let Err(e) = verify_auth_token_claims(&gate.state, &origin, &token) {
        return response_templates::verify_error_response("verify_auth_token_claims failed", e);
    }
    // Normalize the just-verified token into an `Authorization: Bearer` header so
    // a downstream service that reads *only* that header still authenticates —
    // notably emr's JWKS-backed HFS auth on the FHIR router. When the token rode
    // the `wf_auth` cookie (the web path) there is no bearer header for that
    // inner check to find; a request that already carried one is left untouched.
    ensure_bearer_header(req.headers_mut(), &token);
    next.run(req).await
}

/// If `headers` carries no `Authorization: Bearer`, insert one carrying `token`.
/// Lets a cookie-sourced (already-verified) token satisfy a downstream check
/// that reads only the bearer header, without disturbing a request that already
/// presents a bearer. A `token` that can't form a valid header value is skipped
/// — unreachable in practice, since the caller only passes a token the upstream
/// verify already accepted.
fn ensure_bearer_header(headers: &mut HeaderMap, token: &str) {
    if try_bearer_token_from_headers(headers).is_some() {
        return;
    }
    if let Ok(value) = HeaderValue::from_str(&format!("Bearer {token}")) {
        headers.insert(header::AUTHORIZATION, value);
    }
}

/// Whether `path` is in the exempt set. Exact match after trimming trailing
/// slashes, mirroring HFS's own `is_exempt_path` — exact (not prefix) so gating
/// stays precise: `/fhir-r4/metadata-x` is gated, `/fhir-r4/metadata/` is exempt.
fn is_exempt(path: &str, exempt: &[String]) -> bool {
    let path = path.trim_end_matches('/');
    exempt.iter().any(|p| p == path)
}

#[cfg(test)]
mod tests {
    use super::{ensure_bearer_header, is_exempt};
    use axum::http::{header, HeaderMap, HeaderValue};

    fn exempt() -> Vec<String> {
        vec![
            "/fhir-r4/metadata".to_string(),
            "/fhir-r4/.well-known/smart-configuration".to_string(),
        ]
    }

    #[test]
    fn exact_path_is_exempt() {
        assert!(is_exempt("/fhir-r4/metadata", &exempt()));
        assert!(is_exempt(
            "/fhir-r4/.well-known/smart-configuration",
            &exempt()
        ));
    }

    #[test]
    fn trailing_slashes_are_trimmed_before_matching() {
        assert!(is_exempt("/fhir-r4/metadata/", &exempt()));
        assert!(is_exempt("/fhir-r4/metadata///", &exempt()));
    }

    #[test]
    fn near_misses_stay_gated() {
        // Exact, not prefix/substring: a sibling path that merely starts the same
        // is NOT exempt, nor is a deeper path under an exempt one.
        assert!(!is_exempt("/fhir-r4/metadata-x", &exempt()));
        assert!(!is_exempt("/fhir-r4/metadata/extra", &exempt()));
        assert!(!is_exempt("/fhir-r4/Patient", &exempt()));
    }

    #[test]
    fn empty_exempt_list_gates_everything() {
        assert!(!is_exempt("/fhir-r4/metadata", &[]));
    }

    fn bearer(headers: &HeaderMap) -> Option<&str> {
        headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
    }

    #[test]
    fn ensure_bearer_header_injects_a_cookie_sourced_token() {
        // A request that authenticated by the `wf_auth` cookie carries no
        // Authorization header; the gate injects the verified token so a
        // bearer-only downstream (emr's HFS auth) accepts it.
        let mut headers = HeaderMap::new();
        ensure_bearer_header(&mut headers, "the.jwt.value");
        assert_eq!(bearer(&headers), Some("Bearer the.jwt.value"));
    }

    #[test]
    fn ensure_bearer_header_leaves_an_existing_bearer_untouched() {
        // A request that already presents a bearer is left exactly as-is — the
        // gate never overwrites the caller's own header.
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer original.jwt"),
        );
        ensure_bearer_header(&mut headers, "different.jwt");
        assert_eq!(bearer(&headers), Some("Bearer original.jwt"));
    }
}
