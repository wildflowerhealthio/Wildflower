//! The API surface's CORS policy.

use tower_http::cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer};

/// The API surface's CORS policy: mirror any origin, method and request headers
/// (every endpoint is loopback-gated and bearer-authenticated, so CORS is not the
/// access control), and **never** allow credentials.
///
/// Mirroring headers rather than `*` matters: the CORS spec's header wildcard
/// excludes `Authorization`, the one header the bearer clients need. Credentials
/// stay off because every other origin authenticates by `Authorization: Bearer`:
/// the server accepts two cookies, an Owner browser's
/// `__Host-owner_browser_session` and the FHIR UI's `hfs_session`, only from
/// its own pages, with an Origin check on writes (`session_cookie_bearer`),
/// and turns each into a bearer token, so no other origin may read a response
/// one rode on.
pub(crate) fn api_cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::mirror_request())
        .allow_methods(AllowMethods::mirror_request())
        .allow_headers(AllowHeaders::mirror_request())
}

#[cfg(test)]
mod tests {
    use super::api_cors_layer;
    use tower::ServiceExt;

    /// A cross-origin request is never told it may send credentials: the
    /// server's cookies are for its own pages, so no other origin may read a
    /// response one rode on.
    #[tokio::test]
    async fn cross_origin_credentials_are_never_allowed() {
        let router = axum::Router::new()
            .route("/metadata", axum::routing::get(|| async { "ok" }))
            .layer(api_cors_layer());
        let preflight = axum::http::Request::options("/metadata")
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
