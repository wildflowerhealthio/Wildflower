//! Admin `/apps` routes — the owner-only mutate surface. One module per
//! route handler (`create`, `update`, `delete`), each exposing a
//! `MethodRouter`; `router()` is the only path table. POST `/apps` shares
//! its path with the public GET `/apps` (mounted on a different router),
//! and PATCH + DELETE on `/apps/{id}` are merged here.

mod create;
mod delete;
mod update;

use std::sync::Arc;

use axum::Router;

use crate::http::state::AppsState;

pub(super) fn router() -> Router<Arc<AppsState>> {
    Router::new()
        .route("/apps", create::route())
        .route("/apps/{id}", update::route().merge(delete::route()))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;
    use crate::db::AppsStore;
    use crate::http::state::AppsState;

    pub(crate) fn state() -> Arc<AppsState> {
        let store = AppsStore::open_in_memory().expect("store");
        Arc::new(AppsState::new(store, "http://127.0.0.1:8080"))
    }

    pub(crate) async fn send(
        state: &Arc<AppsState>,
        req: Request<Body>,
    ) -> (StatusCode, serde_json::Value) {
        let res = router()
            .with_state(Arc::clone(state))
            .oneshot(req)
            .await
            .expect("oneshot");
        let status = res.status();
        let bytes = res.into_body().collect().await.expect("body").to_bytes();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    pub(crate) fn post(uri: &str, body: serde_json::Value) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    pub(crate) fn patch(uri: &str, body: serde_json::Value) -> Request<Body> {
        Request::builder()
            .method("PATCH")
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    pub(crate) fn delete(uri: &str) -> Request<Body> {
        Request::builder()
            .method("DELETE")
            .uri(uri)
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn full_round_trip_create_update_delete() {
        let st = state();
        // create
        let (status, body) = send(
            &st,
            post(
                "/apps",
                serde_json::json!({
                    "name": "My App",
                    "url": "https://example.com/launch",
                    "requiresTunnel": false,
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["kind"], "custom");
        assert!(body["enabled"].as_bool().unwrap());
        let id = body["id"].as_str().unwrap().to_string();
        assert!(id.starts_with("custom-"));

        // update name
        let (status, body) = send(
            &st,
            patch(
                &format!("/apps/{id}"),
                serde_json::json!({ "name": "Renamed" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["name"], "Renamed");

        // delete
        let (status, body) = send(&st, delete(&format!("/apps/{id}"))).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["deleted"], true);
    }

    #[tokio::test]
    async fn create_rejects_bad_url() {
        let st = state();
        let (status, body) = send(
            &st,
            post(
                "/apps",
                serde_json::json!({
                    "name": "Bad",
                    "url": "javascript:alert(1)",
                    "requiresTunnel": false,
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "InvalidUrl");
    }

    #[tokio::test]
    async fn update_bundled_can_toggle_enabled_but_not_rename() {
        let st = state();
        // toggling enabled works
        let (status, body) = send(
            &st,
            patch(
                "/apps/patient-browser",
                serde_json::json!({ "enabled": false }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["enabled"], false);
        // renaming a bundled app is 403
        let (status, body) = send(
            &st,
            patch(
                "/apps/patient-browser",
                serde_json::json!({ "name": "Hijack" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "BundledAppImmutable");
    }

    #[tokio::test]
    async fn delete_bundled_is_403() {
        let st = state();
        let (status, body) = send(&st, delete("/apps/patient-browser")).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "BundledAppImmutable");
    }

    #[tokio::test]
    async fn delete_unknown_is_404() {
        let st = state();
        let (status, body) = send(&st, delete("/apps/no-such-id")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "AppNotFound");
    }

    #[tokio::test]
    async fn update_unknown_is_404() {
        let st = state();
        let (status, body) = send(
            &st,
            patch("/apps/no-such-id", serde_json::json!({ "enabled": false })),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "AppNotFound");
    }

    /// PATCH with a malformed url for a custom app is 400 (not 422) — the
    /// validator runs before the store update.
    #[tokio::test]
    async fn update_custom_rejects_bad_url() {
        let st = state();
        let (_status, body) = send(
            &st,
            post(
                "/apps",
                serde_json::json!({
                    "name": "Good",
                    "url": "https://example.com",
                    "requiresTunnel": false,
                }),
            ),
        )
        .await;
        let id = body["id"].as_str().unwrap().to_string();
        let (status, body) = send(
            &st,
            patch(
                &format!("/apps/{id}"),
                serde_json::json!({ "url": "http://evil.example.com" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "InvalidUrl");
    }
}
