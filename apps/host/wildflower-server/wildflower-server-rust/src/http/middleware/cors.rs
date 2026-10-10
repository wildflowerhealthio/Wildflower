//! The API surface's CORS policy.

use tower_http::cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer};

/// The API surface's CORS policy: mirror any origin, method and request headers
/// (every endpoint is loopback-gated and bearer-authenticated, so CORS is not the
/// access control), **never** allow credentials, and answer Chrome's Local
/// Network Access preflight.
///
/// Mirroring headers rather than `*` matters: the CORS spec's header wildcard
/// excludes `Authorization`, the one header the bearer clients need. Credentials
/// stay off because the server authenticates by `Authorization: Bearer` alone —
/// no ambient credential (cookie, HTTP auth) exists for a cross-origin page to
/// ride. A page on a public origin — the hosted launcher at
/// `wildflowerhealth.io/launcher/` — fetching this loopback server makes Chrome send
/// `Access-Control-Request-Private-Network: true`, and it blocks the request
/// unless the preflight answers `Access-Control-Allow-Private-Network: true`.
pub(crate) fn api_cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::mirror_request())
        .allow_methods(AllowMethods::mirror_request())
        .allow_headers(AllowHeaders::mirror_request())
        .allow_private_network(true)
}

#[cfg(test)]
mod tests {
    use super::api_cors_layer;
    use tower::ServiceExt;

    /// A preflight from a public origin asking to reach this private-network
    /// server is answered with `Access-Control-Allow-Private-Network: true`;
    /// without it, Chrome blocks the hosted launcher from calling loopback.
    #[tokio::test]
    async fn a_private_network_preflight_is_allowed() {
        let router = axum::Router::new()
            .route("/fhir-r4/metadata", axum::routing::get(|| async { "ok" }))
            .layer(api_cors_layer());
        let preflight = axum::http::Request::options("/fhir-r4/metadata")
            .header("origin", "https://wildflowerhealth.io")
            .header("access-control-request-method", "GET")
            .header("access-control-request-private-network", "true")
            .body(axum::body::Body::empty())
            .expect("preflight request");
        let response = router.oneshot(preflight).await.expect("preflight");
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-private-network")
                .and_then(|value| value.to_str().ok()),
            Some("true")
        );
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-origin")
                .and_then(|value| value.to_str().ok()),
            Some("https://wildflowerhealth.io")
        );
    }

    /// A cross-origin request is never told it may send credentials: the API
    /// authenticates by bearer alone, so no ambient credential may ride.
    #[tokio::test]
    async fn cross_origin_credentials_are_never_allowed() {
        let router = axum::Router::new()
            .route("/fhir-r4/metadata", axum::routing::get(|| async { "ok" }))
            .layer(api_cors_layer());
        let preflight = axum::http::Request::options("/fhir-r4/metadata")
            .header("origin", "https://evil.example")
            .header("access-control-request-method", "GET")
            .header("access-control-request-headers", "authorization")
            .body(axum::body::Body::empty())
            .expect("preflight request");
        let response = router.oneshot(preflight).await.expect("preflight");
        assert!(response
            .headers()
            .get("access-control-allow-credentials")
            .is_none());
        // `Authorization` is still allowed, so bearer clients keep working.
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-headers")
                .and_then(|value| value.to_str().ok()),
            Some("authorization")
        );
    }
}
