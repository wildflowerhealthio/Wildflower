use axum::{routing::get, Json, Router};

/// Empty-state body for `GET /tunnel`, shaped by `TunnelStateSchema` in
/// `slices/tunnel/tunnel-core/src/http-api-definition/tunnel.ts`: no
/// tunnel configured or running, with `servedOrigin` pointing back at
/// the loopback server itself.
fn stub_tunnel_state(loopback_origin: String) -> serde_json::Value {
    serde_json::json!({
        "subdomain": null,
        "rootDomain": null,
        "requestedRunning": false,
        "running": false,
        "currentSubdomain": null,
        "currentRootDomain": null,
        "currentLocalPort": null,
        "error": null,
        "servedOrigin": loopback_origin,
    })
}

/// Temporary stubs for the app-shell API surface the React shell loads
/// on `/_auth/home/` (`ListApps`, `ListRemotes`, `GetTunnel`). The real
/// implementations live in TS (`wildflower-server`) with no Rust
/// counterpart yet. Without these routes the requests fell through to
/// the SPA fallback, whose `200` HTML body failed the client's JSON
/// decode (`ParseError: Could not parse JSON`).
pub fn app_shell_stub_router(loopback_origin: String) -> Router {
    Router::new()
        .route("/apps", get(|| async { Json(serde_json::json!([])) }))
        .route(
            "/collector/remotes",
            get(|| async { Json(serde_json::json!([])) }),
        )
        .route(
            "/tunnel",
            get({
                let origin = loopback_origin.clone();
                move || {
                    let origin = origin.clone();
                    async move { Json(stub_tunnel_state(origin)) }
                }
            }),
        )
}

#[cfg(test)]
mod tests {
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;

    async fn get_json(path: &str) -> (StatusCode, serde_json::Value) {
        let response = app_shell_stub_router("http://localhost:8080".to_string())
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

    /// Whole-value pin of the empty tunnel state — field names and
    /// nullability must keep matching `TunnelStateSchema` on the TS side.
    #[tokio::test]
    async fn stub_tunnel_state_is_the_schema_shaped_empty_state() {
        let (status, body) = get_json("/tunnel").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            serde_json::json!({
                "subdomain": null,
                "rootDomain": null,
                "requestedRunning": false,
                "running": false,
                "currentSubdomain": null,
                "currentRootDomain": null,
                "currentLocalPort": null,
                "error": null,
                "servedOrigin": "http://localhost:8080",
            })
        );
    }
}
