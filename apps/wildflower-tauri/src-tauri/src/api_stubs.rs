use axum::{routing::get, Json, Router};

/// Temporary stubs for the app-shell API surface the React shell loads on
/// `/_auth/home/` (`ListApps`, `ListRemotes`). The real implementations live
/// in TS (`wildflower-server`) with no Rust counterpart yet. Without these
/// routes the requests fell through to the SPA fallback, whose `200` HTML body
/// failed the client's JSON decode (`ParseError: Could not parse JSON`).
///
/// `GetTunnel` used to be stubbed here too; it is now served for real by
/// [`tunnel_rust::setup_tunnel`] (mounted in `lib.rs`).
pub fn app_shell_stub_router() -> Router {
    Router::new()
        .route("/apps", get(|| async { Json(serde_json::json!([])) }))
        .route(
            "/collector/remotes",
            get(|| async { Json(serde_json::json!([])) }),
        )
}

#[cfg(test)]
mod tests {
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;

    async fn get_json(path: &str) -> (StatusCode, serde_json::Value) {
        let response = app_shell_stub_router()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .body(axum::body::Body::empty())
                    .expect("request"),
            )
            .await
            .expect("oneshot");
        let status = response.status();
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let json = serde_json::from_slice(&bytes).expect("stub body must be JSON");
        (status, json)
    }

    #[tokio::test]
    async fn stub_list_endpoints_return_empty_json_arrays() {
        for path in ["/apps", "/collector/remotes"] {
            let (status, body) = get_json(path).await;
            assert_eq!(status, StatusCode::OK, "{path}");
            assert_eq!(body, serde_json::json!([]), "{path}");
        }
    }
}
