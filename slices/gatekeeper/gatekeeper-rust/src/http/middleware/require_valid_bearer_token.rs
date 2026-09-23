use std::sync::Arc;

use crate::http::state::GatekeeperState;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue};
use axum::middleware::{FromFnLayer, Next};

use crate::http::middleware::require_auth::{try_bearer_token_from_headers, verify_request_claims};

/// State for [`gatekeeper_auth_middleware`]'s gate handler.
#[derive(Clone)]
pub struct BearerGate {
    state: Arc<GatekeeperState>,
    exempt: Arc<[String]>,
}

/// Fn-pointer form of the gate handler — nameable so the layer type is too.
type BearerGateFn =
    fn(State<BearerGate>, HeaderMap, Request<Body>, Next) -> super::MiddlewareFuture;

/// The tower `Layer` [`gatekeeper_auth_middleware`] returns.
pub type GatekeeperAuthMiddleware =
    FromFnLayer<BearerGateFn, BearerGate, (State<BearerGate>, HeaderMap, Request<Body>)>;

/// The downstream-slice authN middleware — `401` for a missing/invalid bearer
/// token, except `exempt_paths` which pass through (pass `&[]` to gate every
/// path). Inserts `ScopeClaims` for downstream `Scoped<…>` capabilities.
/// `Clone` — build once, clone per router. See
/// `docs/Authorization/Scope-Gated Endpoints How-To.md`.
pub fn gatekeeper_auth_middleware(
    state: Arc<GatekeeperState>,
    exempt_paths: &[&str],
) -> GatekeeperAuthMiddleware {
    let gate = BearerGate {
        state,
        exempt: exempt_paths
            .iter()
            .map(|p| p.trim_end_matches('/').to_string())
            .collect(),
    };
    let handler: BearerGateFn = |State(gate), headers, mut req, next| {
        Box::pin(async move {
            if is_exempt(req.uri().path(), &gate.exempt) {
                return next.run(req).await;
            }
            let claims = match verify_request_claims(
                &gate.state,
                &headers,
                "access-token verification failed",
            ) {
                Ok(verified) => verified,
                Err(response) => return *response,
            };
            req.extensions_mut()
                .insert(scope_capabilities_rust::ScopeClaims::new(
                    claims.scope.clone(),
                ));
            next.run(req).await
        })
    };
    axum::middleware::from_fn_with_state(gate, handler)
}

/// If `headers` carries no `Authorization: Bearer`, insert `bearer`. Lets the
/// desktop host's owner token (the Tauri loopback-owner-trust middleware)
/// satisfy the bearer gate and any downstream check that reads only the bearer
/// header, without disturbing a request that already presents one.
pub fn ensure_bearer_header(headers: &mut HeaderMap, bearer: &HeaderValue) {
    if try_bearer_token_from_headers(headers).is_some() {
        return;
    }
    headers.insert(header::AUTHORIZATION, bearer.clone());
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
    fn ensure_bearer_header_injects_when_absent() {
        // A direct-loopback desktop request carries no Authorization header;
        // the host injects its owner bearer so the bearer gate accepts it.
        let mut headers = HeaderMap::new();
        ensure_bearer_header(
            &mut headers,
            &HeaderValue::from_static("Bearer the.jwt.value"),
        );
        assert_eq!(bearer(&headers), Some("Bearer the.jwt.value"));
    }

    #[test]
    fn ensure_bearer_header_leaves_an_existing_bearer_untouched() {
        // A request that already presents a bearer is left exactly as-is — the
        // helper never overwrites the caller's own header.
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer original.jwt"),
        );
        ensure_bearer_header(
            &mut headers,
            &HeaderValue::from_static("Bearer different.jwt"),
        );
        assert_eq!(bearer(&headers), Some("Bearer original.jwt"));
    }
}
