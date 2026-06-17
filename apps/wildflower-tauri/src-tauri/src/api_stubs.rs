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
            get(|| async {
                Json(serde_json::json!([{
                    "id": "fhir-demo",
                    "name": "FHIR Demo",
                    "tag": "fhir-r4",
                    "config": {
                          "_tag": "fhir-r4",
                          "rootUrl": "https://r4.smarthealthit.org",
                          "patientId": "8c0f46f4-dd7b-4a5f-bd35-f0f41a2f8882",
                    },
                    "addedAt": "2026-06-17T14:29:22.363Z",
                }]))
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
    async fn apps_endpoint_returns_an_empty_array() {
        let (status, body) = get_json("/apps").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, serde_json::json!([]));
    }

    /// `/collector/remotes` now ships a single FHIR demo remote so the
    /// browser-sniffer flow has something to drive against on a fresh
    /// install. The assertion pins the shape consumers (`collector-react`)
    /// rely on — drift here would surface as a SPA-side decode error
    /// rather than a stub-test failure.
    #[tokio::test]
    async fn collector_remotes_endpoint_returns_the_demo_fhir_remote() {
        let (status, body) = get_json("/collector/remotes").await;
        assert_eq!(status, StatusCode::OK);
        let entries = body.as_array().expect("expected an array response");
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.get("id").and_then(|v| v.as_str()), Some("fhir-demo"));
        assert_eq!(entry.get("tag").and_then(|v| v.as_str()), Some("fhir-r4"));
        let config = entry.get("config").expect("config field");
        assert_eq!(config.get("_tag").and_then(|v| v.as_str()), Some("fhir-r4"));
        assert_eq!(
            config.get("rootUrl").and_then(|v| v.as_str()),
            Some("https://r4.smarthealthit.org"),
        );
    }
}
