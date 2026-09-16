//! The FHIR batch/transaction endpoint lives at the server *base* — a client
//! submits one `POST /` Bundle of PUT entries (this is what `fhir-r4`'s
//! `persistBatchBundle` and `classifyAgainstServer` clients do). Mounted under
//! Wildflower that base is `/fhir-r4/` (with the trailing slash a FHIR base URL
//! conventionally carries).
//!
//! This exercises the seam the per-resource PUT/GET tests never touch: the bare
//! nest root. `nest("/fhir-r4", …)` only registers an exact `/fhir-r4` matcher
//! and a `/fhir-r4/{*rest}` catch-all, and matchit's catch-all does not match
//! zero trailing segments — so `POST /fhir-r4/` matched neither and escaped the
//! nest entirely (in the full app it fell through to the SPA fallback; here, with
//! no such fallback, it surfaced as a 404). `nest_service` claims the whole
//! subtree instead, so the base reaches HFS. See `emr_rust::setup_fhir_r4`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use axum::Router;
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
    let dir = std::env::temp_dir().join(format!("emr-rust-batch-{}-{n}", std::process::id()));
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
    let router = setup_fhir_r4(&runtime, &config, revocation_store)
        .expect("setup_fhir_r4")
        .augmented_fhir_r4_router;
    (router, TempDb { dir })
}

/// Drive the router with one in-process request, returning the status and parsed
/// JSON body (`Value::Null` for an empty body).
async fn send(
    router: &Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("accept", "application/fhir+json");
    let request_body = match &body {
        Some(value) => {
            builder = builder.header("content-type", "application/fhir+json");
            Body::from(serde_json::to_vec(value).expect("serialize request body"))
        }
        None => Body::empty(),
    };
    let request = builder.body(request_body).expect("build request");
    let response = router
        .clone()
        .oneshot(request)
        .await
        .expect("router is infallible");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read response body");
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).expect("parse response JSON")
    };
    (status, value)
}

/// A minimal FHIR batch Bundle carrying one PUT entry — the shape
/// `persistBatchBundle` submits.
fn one_put_batch() -> Value {
    json!({
        "resourceType": "Bundle",
        "type": "batch",
        "entry": [{
            "request": { "method": "PUT", "url": "Patient/p1" },
            "resource": {
                "resourceType": "Patient",
                "id": "p1",
                "name": [{ "family": "Batch", "given": ["Base"] }],
            },
        }],
    })
}

/// The regression this file exists for: a batch Bundle POSTed to the base *with*
/// the trailing slash a FHIR base URL carries must reach HFS and come back as a
/// `batch-response` Bundle — not escape the `/fhir-r4` nest.
#[tokio::test]
async fn batch_bundle_posts_to_base_with_trailing_slash() {
    let (router, _db) = build_router();

    let (status, body) = send(&router, "POST", "/fhir-r4/", Some(one_put_batch())).await;

    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert_eq!(body["resourceType"], "Bundle");
    assert_eq!(body["type"], "batch-response");
    // The single PUT entry's per-entry response reports success.
    let entry_status = body["entry"][0]["response"]["status"]
        .as_str()
        .unwrap_or_else(|| panic!("batch-response entry missing response.status: {body}"));
    assert!(
        entry_status.starts_with("200") || entry_status.starts_with("201"),
        "batch entry write failed: {entry_status} in {body}"
    );

    // The write landed: the resource reads back from HFS.
    let (get_status, got) = send(&router, "GET", "/fhir-r4/Patient/p1", None).await;
    assert_eq!(get_status, StatusCode::OK, "body: {got}");
    assert_eq!(got["resourceType"], "Patient");
    assert_eq!(got["id"], "p1");
}

/// The base without the trailing slash must reach HFS too, so the fix isn't
/// sensitive to which spelling a client uses for the base.
#[tokio::test]
async fn batch_bundle_posts_to_base_without_trailing_slash() {
    let (router, _db) = build_router();

    let (status, body) = send(&router, "POST", "/fhir-r4", Some(one_put_batch())).await;

    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert_eq!(body["resourceType"], "Bundle");
    assert_eq!(body["type"], "batch-response");
}
