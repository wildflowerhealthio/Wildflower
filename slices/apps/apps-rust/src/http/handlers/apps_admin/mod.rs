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

    fn state() -> Arc<AppsState> {
        let store = AppsStore::open_in_memory().expect("store");
        Arc::new(AppsState::new(store, "http://127.0.0.1:8080"))
    }

    async fn send(state: &Arc<AppsState>, req: Request<Body>) -> (StatusCode, serde_json::Value) {
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

    fn post(uri: &str, body: serde_json::Value) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    fn patch(uri: &str, body: serde_json::Value) -> Request<Body> {
        Request::builder()
            .method("PATCH")
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    fn delete(uri: &str) -> Request<Body> {
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

    /// Bundled apps are first-class — every editable field is editable.
    /// Rename, URL swap, and disable all land successfully.
    #[tokio::test]
    async fn bundled_app_can_be_fully_edited() {
        let st = state();
        let (status, body) = send(
            &st,
            patch(
                "/apps/patient-browser",
                serde_json::json!({
                    "name": "Renamed Browser",
                    "url": "https://example.com/replacement",
                    "enabled": false,
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["name"], "Renamed Browser");
        assert_eq!(body["url"], "https://example.com/replacement");
        assert_eq!(body["enabled"], false);
        assert_eq!(body["kind"], "bundled", "provenance survives the edit");
    }

    /// Bundled apps are first-class — including for deletion.
    #[tokio::test]
    async fn bundled_app_can_be_deleted() {
        let st = state();
        let (status, body) = send(&st, delete("/apps/patient-browser")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["deleted"], true);
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

    #[tokio::test]
    async fn update_rejects_bad_url_on_any_kind() {
        let st = state();
        // Even a bundled row's URL has to pass the validator.
        let (status, body) = send(
            &st,
            patch(
                "/apps/patient-browser",
                serde_json::json!({ "url": "http://evil.example.com" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "InvalidUrl");
    }

    /// Explicit `null` for subtitle clears it; an absent key leaves it
    /// alone. The tri-state matters because every other field uses the
    /// usual "absent = no change" semantics.
    #[tokio::test]
    async fn update_subtitle_distinguishes_absent_from_null() {
        let st = state();
        // Set a subtitle through PATCH.
        let (_, _) = send(
            &st,
            patch(
                "/apps/patient-browser",
                serde_json::json!({ "subtitle": "fresh subtitle" }),
            ),
        )
        .await;
        // Absent key — subtitle stays.
        let (_, body) = send(
            &st,
            patch(
                "/apps/patient-browser",
                serde_json::json!({ "enabled": true }),
            ),
        )
        .await;
        assert_eq!(body["subtitle"], "fresh subtitle");
        // Explicit null — subtitle clears.
        let (_, body) = send(
            &st,
            patch(
                "/apps/patient-browser",
                serde_json::json!({ "subtitle": null }),
            ),
        )
        .await;
        assert!(
            body.get("subtitle").is_none() || body["subtitle"].is_null(),
            "expected subtitle to be cleared, got {body}",
        );
    }
}
