//! End-to-end tests for the `/api/dicom/files/{id}` override, exercised
//! through the real routers `setup_fhir_r4` builds (HFS create/read +
//! in-process delegation, see `dicom_files` in `src/`), with HFS auth off
//! (`jwks_url: None`). The FHIR router and the standalone DICOM files router
//! are merged together here the same way the host merges them, since the
//! DICOM route is mounted at the app root rather than under `/fhir-r4`.
//! Covers the happy path (base64 decode + `Content-Type` from the
//! attachment), the octet-stream fallback for a missing/invalid
//! `contentType`, a `DocumentReference` with no content attachment, and a
//! missing `DocumentReference`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use axum::Router;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use emr_rust::{setup_fhir_r4, EmrConfig};
use serde_json::{json, Value};
use shared_structures_rust::ServerRuntimeConfig;
use tower::ServiceExt;

/// Unique temp dir per test so parallel tests don't share a sqlite file.
static COUNTER: AtomicU32 = AtomicU32::new(0);

/// Owns a temp dir for the lifetime of a test, removing it on drop.
struct TempDb {
    dir: PathBuf,
}

impl Drop for TempDb {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Build a fresh FHIR router backed by a throwaway sqlite db. HFS auth is off.
fn build_router() -> (Router, TempDb) {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("emr-rust-dicom-files-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp dir");

    let runtime = ServerRuntimeConfig {
        loopback_base_url: "http://127.0.0.1:8080".parse().expect("parse loopback url"),
        app_data_dir: dir.clone(),
    };
    let config = EmrConfig {
        log_level: "error".to_string(),
        db_file_path: dir.join("health-data.sqlite"),
        jwks_url: None,
        search_parameter_data_dir: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets"),
    };

    let revocation_store = token_revocation_rust::RevocationStore::always_allow();
    let routers = setup_fhir_r4(&runtime, &config, revocation_store).expect("setup_fhir_r4");
    let router = Router::new()
        .merge(routers.fhir_r4)
        .merge(routers.dicom_files);
    (router, TempDb { dir })
}

/// PUT (create-with-id) a `DocumentReference` carrying one content entry.
async fn put_document_reference(router: &Router, id: &str, resource: Value) {
    let request = Request::builder()
        .method("PUT")
        .uri(format!("/fhir-r4/DocumentReference/{id}"))
        .header("accept", "application/fhir+json")
        .header("content-type", "application/fhir+json")
        .body(Body::from(
            serde_json::to_vec(&resource).expect("serialize"),
        ))
        .expect("build request");
    let response = router
        .clone()
        .oneshot(request)
        .await
        .expect("router is infallible");
    assert!(
        response.status().is_success(),
        "PUT DocumentReference/{id} failed: {}",
        response.status()
    );
}

/// GET the DICOM file endpoint, returning the status, the raw response body
/// bytes, and the `Content-Type` header value (if any).
async fn get_file(router: &Router, id: &str) -> (StatusCode, Vec<u8>, Option<String>) {
    let request = Request::builder()
        .method("GET")
        .uri(format!("/api/dicom/files/{id}"))
        .body(Body::empty())
        .expect("build request");
    let response = router
        .clone()
        .oneshot(request)
        .await
        .expect("router is infallible");
    let status = response.status();
    let content_type = response
        .headers()
        .get("content-type")
        .map(|value| value.to_str().expect("content-type is ascii").to_string());
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read response body");
    (status, bytes.to_vec(), content_type)
}

#[tokio::test]
async fn serves_decoded_attachment_bytes_with_its_content_type() {
    let (router, _db) = build_router();

    let raw_bytes = b"\x44\x49\x43\x4d not really DICOM but bytes are bytes".to_vec();
    put_document_reference(
        &router,
        "doc1",
        json!({
            "resourceType": "DocumentReference",
            "id": "doc1",
            "status": "current",
            "content": [{
                "attachment": {
                    "contentType": "application/dicom",
                    "data": STANDARD.encode(&raw_bytes),
                },
            }],
        }),
    )
    .await;

    let (status, body, content_type) = get_file(&router, "doc1").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, raw_bytes);
    assert_eq!(content_type.as_deref(), Some("application/dicom"));
}

#[tokio::test]
async fn falls_back_to_octet_stream_when_content_type_is_absent() {
    let (router, _db) = build_router();

    let raw_bytes = b"raw bytes, no declared content type".to_vec();
    put_document_reference(
        &router,
        "doc1",
        json!({
            "resourceType": "DocumentReference",
            "id": "doc1",
            "status": "current",
            "content": [{
                "attachment": {
                    "data": STANDARD.encode(&raw_bytes),
                },
            }],
        }),
    )
    .await;

    let (status, body, content_type) = get_file(&router, "doc1").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, raw_bytes);
    assert_eq!(content_type.as_deref(), Some("application/octet-stream"));
}

#[tokio::test]
async fn document_reference_with_no_content_yields_404() {
    let (router, _db) = build_router();

    put_document_reference(
        &router,
        "doc1",
        json!({
            "resourceType": "DocumentReference",
            "id": "doc1",
            "status": "current",
            "content": [],
        }),
    )
    .await;

    let (status, _body, _content_type) = get_file(&router, "doc1").await;

    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn missing_document_reference_yields_404() {
    let (router, _db) = build_router();

    let (status, _body, _content_type) = get_file(&router, "does-not-exist").await;

    assert_eq!(status, StatusCode::NOT_FOUND);
}
