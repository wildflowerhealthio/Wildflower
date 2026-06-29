use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::HeaderMap;
use axum::middleware::Next;
use axum::response::Response;

use crate::http::response_templates;
use crate::http::served_origin_for;
use crate::http::state::AppState;

use crate::http::middleware::require_auth::{
    try_bearer_token_from_headers, verify_auth_token_claims,
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
    req: Request<Body>,
    next: Next,
) -> Response {
    // FHIR/SMART discovery docs (metadata, smart-configuration, …) are fetched
    // before the client holds a token, so exempt paths bypass the bearer check —
    // they stay reachable to any local caller (still behind the loopback-peer
    // gate on the merged `api_router`).
    if is_exempt(req.uri().path(), &gate.exempt) {
        return next.run(req).await;
    }
    let Some(token) = try_bearer_token_from_headers(&headers) else {
        return response_templates::unauthorized();
    };
    let origin = served_origin_for(
        &headers,
        &gate.state.loopback_origin.origin().ascii_serialization(),
    );
    if let Err(e) = verify_auth_token_claims(&gate.state, &origin, &token) {
        return response_templates::verify_error_response("verify_auth_token_claims failed", e);
    }
    next.run(req).await
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
    use super::is_exempt;

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
}
