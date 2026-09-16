use std::sync::Arc;

use crate::http::state::GatekeeperState;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue};
use axum::middleware::{FromFnLayer, Next};

use crate::http::middleware::require_auth::{
    try_bearer_token_from_headers, verify_request_claims, AccessTokenSource,
};

/// State for the gate handler: the gatekeeper [`GatekeeperState`] plus the full
/// request paths that skip the token check entirely. Built by
/// [`gatekeeper_auth_middleware`], the module's only way to construct one.
#[derive(Clone)]
pub struct BearerGate {
    state: Arc<GatekeeperState>,
    exempt: Arc<[String]>,
}

/// The gate handler as a plain fn pointer — a nameable stand-in for the
/// unutterable fn-item type of the closure [`gatekeeper_auth_middleware`]
/// builds. See [`MiddlewareFuture`](super::MiddlewareFuture) for why the future
/// is boxed.
type BearerGateFn =
    fn(State<BearerGate>, HeaderMap, Request<Body>, Next) -> super::MiddlewareFuture;

/// The tower `Layer` [`gatekeeper_auth_middleware`] returns — spelled out
/// because axum's [`FromFnLayer`] is generic over the handler and its
/// extractors, and a return-position `impl Layer` can't name the associated
/// `Service` type `Router::layer` bounds.
pub type GatekeeperAuthMiddleware =
    FromFnLayer<BearerGateFn, BearerGate, (State<BearerGate>, HeaderMap, Request<Body>)>;

/// The downstream-slice authN middleware — pass it to `Router::layer` to
/// authenticate a slice router (e.g. emr-rust's FHIR router) against the
/// gatekeeper's signing keys. Any request missing or presenting an invalid
/// bearer token gets 401 — **except** requests whose path is in `exempt_paths`,
/// which pass through untouched: the FHIR/SMART discovery docs a client fetches
/// before it holds a token (canonical list `UNAUTHENTICATED_FHIR_PATHS` in
/// emr-rust; see `docs/Origins/Explanation.md`). Matching is exact on the full
/// request path with a trailing slash ignored (see `is_exempt`). Pass `&[]` to
/// gate every path.
///
/// This is the other half of the claims-inserting **pair** (see
/// `docs/Authorization/Scope-Gated Endpoints How-To.md`, "Wiring the claims"):
/// [`require_valid_session`](super::require_auth::require_valid_session) guards
/// gatekeeper's own `/access` and inserts the domain `VerifiedClaims`; this gate
/// fronts the host's other slice routers (emr/HFS, databases, …) and inserts the
/// framework-neutral `ScopeClaims`. Both run the same [`verify_request_claims`]
/// pipeline, so a token is verified exactly once and identically wherever it
/// lands.
///
/// The returned value is [`Clone`], so a host gating several routers on the same
/// state and exempt set builds it once and clones it per router.
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
            // Exempt paths (the discovery docs fetched before a client holds a
            // token) bypass the bearer check, still behind the loopback-peer gate
            // on the merged `api_router`. See `docs/Origins/Explanation.md`.
            if is_exempt(req.uri().path(), &gate.exempt) {
                return next.run(req).await;
            }
            let (claims, (token, source)) = match verify_request_claims(
                &gate.state,
                &headers,
                "verify_auth_token_claims failed",
            ) {
                Ok(verified) => verified,
                Err(response) => return *response,
            };
            // Hand the caller's scope claim to any downstream slice router that
            // scope-gates its endpoints via a `Scoped<…>` capability (databases,
            // …). This is the seam that lets those slices authorize per-resource
            // without depending on gatekeeper's domain `VerifiedClaims` type —
            // they read the framework-neutral `ScopeClaims` from
            // `scope-capabilities-rust`. Harmless for routers that don't read it
            // (emr/HFS, tunnel, collector today).
            req.extensions_mut()
                .insert(scope_capabilities_rust::ScopeClaims::new(
                    claims.scope.clone(),
                ));
            // Normalize a cookie-sourced token into an `Authorization: Bearer`
            // header so a downstream service that reads *only* that header still
            // authenticates — notably emr's JWKS-backed HFS auth on the FHIR
            // router. A bearer-sourced request already carries that header, so
            // it's skipped entirely (no `format!` + parse, no second header scan)
            // — the token source is carried from extraction rather than
            // re-derived here.
            if source == AccessTokenSource::Cookie {
                if let Ok(bearer) = HeaderValue::from_str(&format!("Bearer {token}")) {
                    ensure_bearer_header(req.headers_mut(), &bearer);
                }
            }
            next.run(req).await
        })
    };
    axum::middleware::from_fn_with_state(gate, handler)
}

/// If `headers` carries no `Authorization: Bearer`, insert `bearer`. Lets a
/// cookie-sourced (already-verified) token — or, on desktop, the host's owner
/// token — satisfy a downstream check that reads only the bearer header, without
/// disturbing a request that already presents one. Shared by the FHIR bearer
/// gate here and the Tauri loopback-owner-trust middleware, so the "insert a
/// bearer only when absent" rule lives in exactly one place.
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
        // A request that authenticated by the `wf_auth` cookie carries no
        // Authorization header; the gate injects the prebuilt bearer so a
        // bearer-only downstream (emr's HFS auth) accepts it.
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
