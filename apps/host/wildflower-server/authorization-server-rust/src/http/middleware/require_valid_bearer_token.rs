//! The layerable bearer gate the host wraps its downstream routers in
//! ([`authorization_server_auth_middleware`]): the same token check as the
//! `/authorization` session gate, handing the framework-neutral `ScopeClaims`
//! to the routes behind it, with an exact-match list of paths that pass
//! ungated. Also [`ensure_bearer_header`], which the host's cookie→bearer layer
//! uses to present a session cookie's token as the request's bearer.

use std::sync::Arc;

use crate::http::state::AuthorizationServerState;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue};
use axum::middleware::{FromFnLayer, Next};
use wildflowerhealthio_shared_structures::request_caller::RequestCaller;

use crate::http::middleware::require_auth::{try_bearer_token_from_headers, verify_request_claims};

/// State for [`authorization_server_auth_middleware`]'s gate handler.
#[derive(Clone)]
pub struct BearerGate {
    /// The router state, whose token verifier checks each bearer.
    state: Arc<AuthorizationServerState>,
    /// The paths that pass without a token, trailing slashes trimmed, matched
    /// exactly by `is_exempt`.
    exempt: Arc<[String]>,
}

/// Fn-pointer form of the gate handler — nameable so the layer type is too.
type BearerGateFn =
    fn(State<BearerGate>, HeaderMap, Request<Body>, Next) -> super::MiddlewareFuture;

/// The tower `Layer` [`authorization_server_auth_middleware`] returns.
pub type AuthorizationServerAuthMiddleware =
    FromFnLayer<BearerGateFn, BearerGate, (State<BearerGate>, HeaderMap, Request<Body>)>;

/// The downstream-slice authN middleware — `401` for a missing/invalid bearer
/// token, except `exempt_paths` which pass through (pass `&[]` to gate every
/// path). Inserts `ScopeClaims` for downstream `Scoped<…>` capabilities, and
/// stamps the response with the verified [`RequestCaller`] (an
/// exempt path's response carries none; a `401` carries the
/// [`RequestRefusal`](wildflowerhealthio_shared_structures::request_caller::RequestRefusal)
/// `verify_request_claims` stamped instead).
/// `Clone` — build once, clone per router. See
/// `docs/Authorization/Scope-Gated Endpoints How-To.md`.
pub fn authorization_server_auth_middleware(
    state: Arc<AuthorizationServerState>,
    exempt_paths: &[&str],
) -> AuthorizationServerAuthMiddleware {
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
                .insert(wildflowerhealthio_scope_capabilities::ScopeClaims::new(
                    claims.scope.clone(),
                ));
            let mut response = next.run(req).await;
            // Name the verified caller on the response, as `require_valid_session`
            // does, for the host's forwarded-request observer.
            response.extensions_mut().insert(RequestCaller {
                client_id: claims.subject,
            });
            response
        })
    };
    axum::middleware::from_fn_with_state(gate, handler)
}

/// If `headers` carries no `Authorization: Bearer`, insert `bearer`. Lets a
/// session cookie's token (the host's `session_cookie_bearer` layer, for the
/// browser session and the FHIR web UI's session) satisfy the bearer gate and
/// any downstream check that reads only the bearer header, without disturbing
/// a request that already presents one.
pub fn ensure_bearer_header(headers: &mut HeaderMap, bearer: &HeaderValue) {
    if try_bearer_token_from_headers(headers).is_some() {
        return;
    }
    headers.insert(header::AUTHORIZATION, bearer.clone());
}

/// Whether `path` is in the exempt set. Exact match after trimming trailing
/// slashes, mirroring HFS's own `is_exempt_path` — exact (not prefix) so gating
/// stays precise: `/metadata-x` is gated, `/metadata/` is exempt.
fn is_exempt(path: &str, exempt: &[String]) -> bool {
    let path = path.trim_end_matches('/');
    exempt.iter().any(|p| p == path)
}

#[cfg(test)]
mod tests {
    use super::{ensure_bearer_header, is_exempt};
    use axum::http::{header, HeaderMap, HeaderValue};

    /// An exempt list like the host's: the FHIR capability statement and the
    /// SMART discovery document.
    fn exempt() -> Vec<String> {
        vec![
            "/metadata".to_string(),
            "/.well-known/smart-configuration".to_string(),
        ]
    }

    /// A path on the exempt list passes ungated.
    #[test]
    fn exact_path_is_exempt() {
        assert!(is_exempt("/metadata", &exempt()));
        assert!(is_exempt("/.well-known/smart-configuration", &exempt()));
    }

    /// Trailing slashes on the request path don't stop an exempt path matching.
    #[test]
    fn trailing_slashes_are_trimmed_before_matching() {
        assert!(is_exempt("/metadata/", &exempt()));
        assert!(is_exempt("/metadata///", &exempt()));
    }

    /// The match is exact: a sibling path that starts the same, a deeper path
    /// under an exempt one, and any other path are all gated.
    #[test]
    fn near_misses_stay_gated() {
        // Exact, not prefix/substring: a sibling path that merely starts the same
        // is NOT exempt, nor is a deeper path under an exempt one.
        assert!(!is_exempt("/metadata-x", &exempt()));
        assert!(!is_exempt("/metadata/extra", &exempt()));
        assert!(!is_exempt("/Patient", &exempt()));
    }

    /// With no exempt paths, every path is gated.
    #[test]
    fn empty_exempt_list_gates_everything() {
        assert!(!is_exempt("/metadata", &[]));
    }

    /// The `Authorization` header's value, if `headers` carry one.
    fn bearer(headers: &HeaderMap) -> Option<&str> {
        headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
    }

    /// A request with no `Authorization` header gets the session's bearer.
    #[test]
    fn ensure_bearer_header_injects_when_absent() {
        // A signed-in web UI request carries no Authorization header; the host
        // injects its session's bearer so the bearer gate accepts it.
        let mut headers = HeaderMap::new();
        ensure_bearer_header(
            &mut headers,
            &HeaderValue::from_static("Bearer the.jwt.value"),
        );
        assert_eq!(bearer(&headers), Some("Bearer the.jwt.value"));
    }

    /// A request that already presents a bearer keeps its own.
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
