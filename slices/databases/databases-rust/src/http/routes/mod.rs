//! HTTP routes for the databases slice — the three `/databases` endpoints as one
//! [`openapi_router`]. The folder tree mirrors the URL tree (`databases/` for the
//! `/databases` segment, one file per operation); the served routes and the
//! OpenAPI spec come from the same `#[utoipa::path]`-annotated handlers.
//! `GET /databases/{id}` (download) and `DELETE /databases/{id}` share a path, so
//! `routes!` merges them into one path-item entry.

mod databases;

use std::sync::Arc;

use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::http::state::DatabasesState;

/// The whole databases surface as an `OpenApiRouter` — the spec-bearing inner of
/// [`super::router`]. Every route is Owner-only; the host wraps the built router
/// with its auth gate.
pub(crate) fn openapi_router() -> OpenApiRouter<Arc<DatabasesState>> {
    OpenApiRouter::new()
        .routes(routes!(databases::list_all::handle_list_databases))
        .routes(routes!(
            databases::download_by_id::handle_download_database,
            databases::delete_by_id::handle_delete_database
        ))
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use rusqlite::Connection;
    use tower::ServiceExt;

    use super::*;
    use crate::config::DatabaseDescriptor;
    use crate::http::state::DatabasesState;

    /// The served router (OpenAPI spec discarded) for exercising the handlers
    /// via `oneshot`.
    fn router() -> axum::Router<Arc<DatabasesState>> {
        openapi_router().split_for_parts().0
    }

    /// The catalogue the tests expose — mirrors what the Tauri host passes.
    fn descriptors() -> Vec<DatabaseDescriptor> {
        vec![
            DatabaseDescriptor {
                id: "health-data.sqlite".to_owned(),
                label: "Health data".to_owned(),
                description: "Your clinical records.".to_owned(),
            },
            DatabaseDescriptor {
                id: "wildflower.sqlite".to_owned(),
                label: "Wildflower app data".to_owned(),
                description: "App state.".to_owned(),
            },
        ]
    }

    /// Create a real SQLite database at `path` with `tables` user tables, so
    /// metadata reads (size, table count) and the export snapshot have
    /// something faithful to work against.
    fn seed_db(path: &Path, tables: usize) {
        let conn = Connection::open(path).expect("open seed db");
        for i in 0..tables {
            conn.execute_batch(&format!(
                "CREATE TABLE t{i} (id INTEGER PRIMARY KEY, v TEXT);"
            ))
            .expect("create table");
        }
    }

    fn state_with(dir: &Path) -> Arc<DatabasesState> {
        Arc::new(DatabasesState::new(dir.to_path_buf(), descriptors()))
    }

    async fn send(state: &Arc<DatabasesState>, req: Request<Body>) -> (StatusCode, Vec<u8>) {
        let res = router()
            .with_state(Arc::clone(state))
            .oneshot(req)
            .await
            .expect("oneshot");
        let status = res.status();
        let bytes = res.into_body().collect().await.expect("body").to_bytes();
        (status, bytes.to_vec())
    }

    async fn send_json(
        state: &Arc<DatabasesState>,
        req: Request<Body>,
    ) -> (StatusCode, serde_json::Value) {
        let (status, bytes) = send(state, req).await;
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    fn get(uri: &str) -> Request<Body> {
        Request::builder().uri(uri).body(Body::empty()).unwrap()
    }

    fn delete(uri: &str) -> Request<Body> {
        Request::builder()
            .method("DELETE")
            .uri(uri)
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn list_reports_metadata_for_every_catalogued_database() {
        let dir = tempfile::tempdir().expect("tempdir");
        seed_db(&dir.path().join("health-data.sqlite"), 3);
        // `wildflower.sqlite` is intentionally left absent to exercise the
        // missing-file branch.
        let st = state_with(dir.path());

        let (status, body) = send_json(&st, get("/databases")).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        let entries = body.as_array().expect("array");
        assert_eq!(entries.len(), 2, "one entry per catalogue database");

        let health = entries
            .iter()
            .find(|e| e["id"] == "health-data.sqlite")
            .expect("health entry");
        assert_eq!(health["exists"], serde_json::json!(true));
        assert_eq!(health["label"], serde_json::json!("Health data"));
        assert_eq!(health["tableCount"], serde_json::json!(3));
        assert!(
            health["sizeBytes"].as_u64().expect("size is a number") > 0,
            "an existing db has a non-zero size: {health}"
        );
        assert!(health["modifiedAt"].is_string(), "mtime present: {health}");
        assert_eq!(health["pendingDeletion"], serde_json::json!(false));

        let wildflower = entries
            .iter()
            .find(|e| e["id"] == "wildflower.sqlite")
            .expect("wildflower entry");
        assert_eq!(wildflower["exists"], serde_json::json!(false));
        assert_eq!(wildflower["sizeBytes"], serde_json::json!(0));
        assert_eq!(wildflower["tableCount"], serde_json::Value::Null);
        assert_eq!(wildflower["modifiedAt"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn download_returns_a_valid_sqlite_snapshot() {
        let dir = tempfile::tempdir().expect("tempdir");
        seed_db(&dir.path().join("health-data.sqlite"), 2);
        let st = state_with(dir.path());

        let res = router()
            .with_state(Arc::clone(&st))
            .oneshot(get("/databases/health-data.sqlite"))
            .await
            .expect("oneshot");
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok()),
            Some("application/vnd.sqlite3"),
        );
        assert!(
            res.headers()
                .get("content-disposition")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.contains("health-data.sqlite")),
            "filename in content-disposition",
        );
        let bytes = res.into_body().collect().await.expect("body").to_bytes();
        // A real SQLite file starts with this 16-byte magic header.
        assert!(
            bytes.starts_with(b"SQLite format 3\0"),
            "export body is a SQLite database",
        );
    }

    #[tokio::test]
    async fn download_unknown_id_is_404() {
        let dir = tempfile::tempdir().expect("tempdir");
        let st = state_with(dir.path());
        let (status, body) = send_json(&st, get("/databases/not-a-db.sqlite")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "DatabaseNotFound");
    }

    #[tokio::test]
    async fn download_known_but_absent_is_404() {
        let dir = tempfile::tempdir().expect("tempdir");
        let st = state_with(dir.path());
        // `wildflower.sqlite` is catalogued but was never created.
        let (status, body) = send_json(&st, get("/databases/wildflower.sqlite")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "DatabaseNotFound");
    }

    #[tokio::test]
    async fn delete_schedules_and_marks_the_database_pending() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("wildflower.sqlite");
        seed_db(&path, 1);
        let st = state_with(dir.path());

        let (status, body) = send_json(&st, delete("/databases/wildflower.sqlite")).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["deleted"], serde_json::json!(true));
        // The file is held open by the owning slice, so it survives until the
        // host purges it at restart — but a marker now exists and the listing
        // reports it pending.
        assert!(path.exists(), "the live file is not removed at runtime");
        assert!(
            dir.path().join("wildflower.sqlite.pending-delete").exists(),
            "marker written"
        );

        let (_, body) = send_json(&st, get("/databases")).await;
        let wildflower = body
            .as_array()
            .expect("array")
            .iter()
            .find(|e| e["id"] == "wildflower.sqlite")
            .expect("wildflower entry");
        assert_eq!(wildflower["pendingDeletion"], serde_json::json!(true));
    }

    #[tokio::test]
    async fn purge_pending_deletions_removes_the_db_and_sidecars_at_startup() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("wildflower.sqlite");
        seed_db(&path, 1);
        let journal = dir.path().join("wildflower.sqlite-journal");
        std::fs::write(&journal, b"stale journal").expect("write journal");
        let st = state_with(dir.path());

        // Schedule the deletion through the handler, then run the startup purge.
        let (status, _) = send_json(&st, delete("/databases/wildflower.sqlite")).await;
        assert_eq!(status, StatusCode::OK);
        crate::files::purge_pending_deletions(dir.path()).expect("purge");

        assert!(!path.exists(), "main file removed at startup");
        assert!(!journal.exists(), "journal sidecar removed");
        assert!(
            !dir.path().join("wildflower.sqlite.pending-delete").exists(),
            "marker removed",
        );
    }

    #[tokio::test]
    async fn delete_unknown_id_is_404() {
        let dir = tempfile::tempdir().expect("tempdir");
        let st = state_with(dir.path());
        // An id that isn't in the catalogue never resolves to a path, so it
        // can't escape the data dir — it's a structured `DatabaseNotFound`.
        let (status, body) = send_json(&st, delete("/databases/secrets.sqlite")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "DatabaseNotFound");
    }

    #[tokio::test]
    async fn delete_known_but_absent_is_404() {
        let dir = tempfile::tempdir().expect("tempdir");
        let st = state_with(dir.path());
        // `wildflower.sqlite` is catalogued but was never created.
        let (status, body) = send_json(&st, delete("/databases/wildflower.sqlite")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "DatabaseNotFound");
    }
}
