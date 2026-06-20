//! Admin `/apps` routes — the owner-only mutate surface. One module per
//! route handler (`create`, `update`, `delete`), each exposing a
//! `#[utoipa::path]`-annotated handler. POST `/apps` shares its path with the
//! public GET `/apps` (mounted on a different router); PATCH + DELETE on
//! `/apps/{id}` share a path here, so they collect into one `routes!`.

mod create;
mod delete;
mod update;

use std::sync::Arc;

use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::http::state::AppsState;

/// The admin `/apps` routes (`POST /apps`, `PATCH`/`DELETE /apps/{id}`) as an
/// `OpenApiRouter`. The router carries no middleware — the host wraps it with
/// its own auth gate.
pub(crate) fn openapi_router() -> OpenApiRouter<Arc<AppsState>> {
    OpenApiRouter::new()
        .routes(routes!(create::handle_create_app))
        .routes(routes!(
            update::handle_update_app,
            delete::handle_delete_app
        ))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::Router;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;
    use crate::db::AppsStore;
    use crate::http::state::AppsState;

    /// The served admin router, state not yet applied.
    fn router() -> Router<Arc<AppsState>> {
        openapi_router().split_for_parts().0
    }

    fn state() -> Arc<AppsState> {
        // The admin surface never touches the tunnel, so the offline null-impl
        // is enough.
        let store = AppsStore::open_in_memory().expect("store");
        let tunnel = Arc::new(shared_structures_rust::tunnel_service::OfflineTunnel::new(
            "http://127.0.0.1:8080",
        ));
        Arc::new(AppsState::new(store, "http://127.0.0.1:8080", tunnel))
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
        assert!(body["enabled"].as_bool().unwrap());
        let id = body["id"].as_str().unwrap().to_string();
        assert!(!id.is_empty());

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

    /// An empty name is a 400 tagged `InvalidName`, not `InvalidUrl` — a
    /// client switching on `error` must be able to tell a name problem from a
    /// URL problem.
    #[tokio::test]
    async fn create_rejects_empty_name_with_invalid_name() {
        let st = state();
        let (status, body) = send(
            &st,
            post(
                "/apps",
                serde_json::json!({
                    "name": "",
                    "url": "https://example.com/x",
                    "requiresTunnel": false,
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "InvalidName");
    }

    /// Every app is first-class — every editable field is editable.
    /// Rename, URL swap, and disable all land successfully.
    #[tokio::test]
    async fn seeded_app_can_be_fully_edited() {
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
    }

    /// Every app is first-class — including for deletion.
    #[tokio::test]
    async fn seeded_app_can_be_deleted() {
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

    /// Existence is resolved before the patch fields are validated, so a PATCH
    /// to an unknown id with an *also-invalid* url is a 404 (missing resource),
    /// not a 400 — the missing-resource signal isn't masked by field validation.
    #[tokio::test]
    async fn update_unknown_with_bad_url_is_still_404() {
        let st = state();
        let (status, body) = send(
            &st,
            patch(
                "/apps/no-such-id",
                serde_json::json!({ "url": "javascript:alert(1)" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "AppNotFound");
    }

    #[tokio::test]
    async fn update_rejects_bad_url() {
        let st = state();
        // Every row's URL has to pass the validator.
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
