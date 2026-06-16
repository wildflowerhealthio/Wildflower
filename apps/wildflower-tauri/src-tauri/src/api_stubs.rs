use axum::{routing::get, Json, Router};

/// Temporary stubs for the app-shell API surface the React shell loads on
/// `/_auth/home/` (`ListRemotes`). The real implementations live in TS
/// (`wildflower-server`) with no Rust counterpart yet. Without these routes
/// the requests fell through to the SPA fallback, whose `200` HTML body
/// failed the client's JSON decode (`ParseError: Could not parse JSON`).
///
/// `GetTunnel` used to be stubbed here too; it is now served for real by
/// [`tunnel_rust::setup_tunnel`]. `ListApps` (`GET /apps`) plus the rest of
/// the apps catalogue is now served for real by [`apps_rust::setup_apps`]
/// — both are mounted in `lib.rs`.
pub fn app_shell_stub_router() -> Router {
    Router::new().route(
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
    async fn collector_remotes_stub_returns_an_empty_json_array() {
        let (status, body) = get_json("/collector/remotes").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, serde_json::json!([]));
    }
}
