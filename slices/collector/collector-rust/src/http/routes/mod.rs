//! HTTP routes for the collector slice — the five `/collector/remotes`
//! endpoints as one [`openapi_router`]. The served routes and the OpenAPI spec
//! come from the same `#[utoipa::path]`-annotated handlers.

mod remotes;

use std::sync::Arc;

use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::http::state::CollectorState;

/// The whole collector surface as an `OpenApiRouter` — the spec-bearing inner
/// of [`router`](super::router). Every route is owner-only; the host wraps the
/// built router with its bearer gate.
pub(crate) fn openapi_router() -> OpenApiRouter<Arc<CollectorState>> {
    OpenApiRouter::new()
        .routes(routes!(
            remotes::list_all::handle_list_remotes,
            remotes::create::handle_create_remote
        ))
        .routes(routes!(
            remotes::get_by_id::handle_get_remote,
            remotes::update_by_id::handle_update_remote,
            remotes::delete_by_id::handle_delete_remote
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

    use crate::db::SqliteRemotesStore;
    use crate::http::state::CollectorState;

    fn state() -> Arc<CollectorState> {
        Arc::new(CollectorState::new(
            SqliteRemotesStore::open_in_memory().expect("in-memory store"),
        ))
    }

    /// The served router (state applied per-call). Spec half of
    /// `split_for_parts` is irrelevant in the handler tests.
    fn router() -> Router<Arc<CollectorState>> {
        super::openapi_router().split_for_parts().0
    }

    async fn send(
        state: &Arc<CollectorState>,
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

    fn get(uri: &str) -> Request<Body> {
        Request::builder().uri(uri).body(Body::empty()).unwrap()
    }

    fn post_json(uri: &str, body: serde_json::Value) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    fn put_json(uri: &str, body: serde_json::Value) -> Request<Body> {
        Request::builder()
            .method("PUT")
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

    /// The list ships the migration-seeded demo remote with the exact wire
    /// shape the retired api_stubs stub served — camelCase `addedAt` pinned to
    /// the static demo-install date, `tag` + verbatim config JSON — so a fresh
    /// install keeps today's demo behavior and the SPA decode can't break.
    #[tokio::test]
    async fn list_remotes_returns_the_seeded_demo_fhir_remote() {
        let st = state();
        let (status, body) = send(&st, get("/collector/remotes")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            serde_json::json!([{
                "id": "fhir-demo",
                "name": "FHIR Demo",
                "tag": "fhir-r4",
                "config": {
                    "_tag": "fhir-r4",
                    "rootUrl": "https://r4.smarthealthit.org",
                    "patientId": "8c0f46f4-dd7b-4a5f-bd35-f0f41a2f8882",
                },
                "addedAt": "2026-06-17T14:29:22.363Z",
            }]),
        );
    }

    /// The 404 wire shape on all three id-addressed endpoints — the TS
    /// `RemoteNotFoundSchema`: `{"error":"RemoteNotFound","id":…}`.
    #[tokio::test]
    async fn unknown_id_is_the_structured_remote_not_found_404() {
        let st = state();
        for req in [
            get("/collector/remotes/no-such-id"),
            put_json(
                "/collector/remotes/no-such-id",
                serde_json::json!({ "name": "n", "config": { "_tag": "fhir-r4" } }),
            ),
            delete("/collector/remotes/no-such-id"),
        ] {
            let method = req.method().clone();
            let (status, body) = send(&st, req).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method}");
            assert_eq!(
                body,
                serde_json::json!({ "error": "RemoteNotFound", "id": "no-such-id" }),
                "{method}",
            );
        }
    }

    /// The issue's acceptance round-trip: create → get → update → delete,
    /// asserting each response's wire shape along the way.
    #[tokio::test]
    async fn full_round_trip_create_get_update_delete() {
        let st = state();
        let config = serde_json::json!({
            "_tag": "fhir-r4",
            "rootUrl": "https://fhir.example.com",
            "patientId": "p-1",
        });
        let (status, created) = send(
            &st,
            post_json(
                "/collector/remotes",
                serde_json::json!({ "id": "r1", "name": "Mine", "config": config }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {created}");
        assert_eq!(created["id"], "r1");
        assert_eq!(created["name"], "Mine");
        assert_eq!(
            created["tag"], "fhir-r4",
            "tag is denormalized from config._tag"
        );
        assert_eq!(created["config"], config);
        let added_at = created["addedAt"].as_str().expect("addedAt is a string");
        // Pin the ISO-8601 encoding (millis + `Z`) the TS DateTimeUtc decodes.
        assert!(
            added_at.len() == 24 && added_at.ends_with('Z') && added_at.contains('.'),
            "addedAt must be ISO-8601 UTC with milliseconds, got {added_at}",
        );

        let (status, fetched) = send(&st, get("/collector/remotes/r1")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(fetched, created);

        let new_config = serde_json::json!({ "_tag": "fhir-r4", "rootUrl": "https://other" });
        let (status, updated) = send(
            &st,
            put_json(
                "/collector/remotes/r1",
                serde_json::json!({ "name": "Renamed", "config": new_config }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {updated}");
        assert_eq!(updated["name"], "Renamed");
        assert_eq!(updated["config"], new_config);
        assert_eq!(
            updated["addedAt"], created["addedAt"],
            "an update must not touch addedAt",
        );

        let (status, deleted) = send(&st, delete("/collector/remotes/r1")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(deleted, serde_json::json!({ "deleted": true }));

        let (status, _body) = send(&st, get("/collector/remotes/r1")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    /// The config union is TS-owned: a tag Rust has never heard of is stored
    /// and served verbatim (adding a TS collector must not require a Rust
    /// change), with `tag` still denormalized from it.
    #[tokio::test]
    async fn create_accepts_an_unmodeled_collector_config_verbatim() {
        let st = state();
        let config = serde_json::json!({
            "_tag": "rexall",
            "username": "u",
            "password": "p",
        });
        let (status, created) = send(
            &st,
            post_json(
                "/collector/remotes",
                serde_json::json!({ "id": "rx", "name": "Pharmacy", "config": config }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {created}");
        assert_eq!(created["tag"], "rexall");
        assert_eq!(created["config"], config);
    }

    /// A config without a string `_tag` can't produce the `tag` column — 400,
    /// nothing stored. (Unreachable through the typed TS client.)
    #[tokio::test]
    async fn create_rejects_a_config_without_a_string_tag() {
        let st = state();
        let (status, body) = send(
            &st,
            post_json(
                "/collector/remotes",
                serde_json::json!({ "id": "bad", "name": "n", "config": { "rootUrl": "x" } }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "InvalidConfig");
        let (status, _body) = send(&st, get("/collector/remotes/bad")).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "nothing was stored");
    }

    /// A create on a taken id is a 409 and leaves the existing row untouched
    /// (ids are client-minted, so a duplicate is a plausible client bug).
    #[tokio::test]
    async fn create_on_a_taken_id_is_409_without_overwriting() {
        let st = state();
        let (status, body) = send(
            &st,
            post_json(
                "/collector/remotes",
                serde_json::json!({
                    "id": "fhir-demo",
                    "name": "Impostor",
                    "config": { "_tag": "fhir-r4" },
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            body,
            serde_json::json!({ "error": "RemoteAlreadyExists", "id": "fhir-demo" }),
        );
        let (_status, seeded) = send(&st, get("/collector/remotes/fhir-demo")).await;
        assert_eq!(seeded["name"], "FHIR Demo", "the seeded row is untouched");
    }
}
