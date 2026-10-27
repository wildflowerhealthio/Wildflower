//! The FHIR batch/transaction endpoint lives at the server *base* — a client
//! submits one `POST /` Bundle of PUT entries (this is what `fhir-r4`'s
//! `persistBatchBundle`, `persistTransactionBundle` and `classifyAgainstServer`
//! clients do). Wildflower serves FHIR at the root, so that base is the bare
//! `/`, a path the per-resource PUT/GET tests never touch: it must reach HFS
//! through `setup_fhir_r4`'s overrides rather than match none of them.
//!
//! A `transaction` Bundle is atomic on HFS's SQLite backend: every entry lands
//! or none does. The importer's confirm writes a batch, its linked records
//! among them, as one transaction on that promise, so a reference from one
//! format's resource to another's never dangles; the tests here pin it.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use axum::Router;
use serde_json::{json, Value};
use tower::ServiceExt;
use wildflowerhealthio_fhir_r4::{setup_fhir_r4, ui_login_config, FhirR4Config};

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
    let dir = std::env::temp_dir().join(format!("fhir-r4-rust-batch-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp dir");

    let config = FhirR4Config {
        log_level: "error".to_string(),
        db_file_path: dir.join("health-data.sqlite"),
        bulk_export_dir: dir.join("fhir-exports"),
        search_parameter_data_dir: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets"),
        public_origin: "https://dev1.example.com"
            .parse()
            .expect("parse public origin"),
        authorization_app_base:
            wildflowerhealthio_shared_structures::authorization_app::AuthorizationAppBase::parse(
                "https://authorization.wildflowerhealth.io/",
            )
            .expect("parse the authorization app base"),
    };

    let router = setup_fhir_r4(
        &config,
        // No verifier: HFS auth is off.
        None,
        ui_sessions(&config),
        // No host gate in front: these drive HFS and the UI directly.
        tower::layer::util::Identity::new(),
    )
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

/// A batch Bundle POSTed to the base must reach HFS and come back as a
/// `batch-response` Bundle.
#[tokio::test]
async fn batch_bundle_posts_to_base() {
    let (router, _db) = build_router();

    let (status, body) = send(&router, "POST", "/", Some(one_put_batch())).await;

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
    let (get_status, got) = send(&router, "GET", "/Patient/p1", None).await;
    assert_eq!(get_status, StatusCode::OK, "body: {got}");
    assert_eq!(got["resourceType"], "Patient");
    assert_eq!(got["id"], "p1");
}

/// The web UI's session store `setup_fhir_r4` takes, as the host builds it.
fn ui_sessions(config: &FhirR4Config) -> std::sync::Arc<helios_auth::SessionStore> {
    std::sync::Arc::new(helios_auth::SessionStore::new(ui_login_config(
        &config.public_origin,
        "fhir-ui-client",
    )))
}

/// A `transaction` Bundle of PUT entries: the shape the importer's confirm
/// submits once a batch's resources reference each other across formats.
fn transaction_of(entries: Vec<Value>) -> Value {
    json!({
        "resourceType": "Bundle",
        "type": "transaction",
        "entry": entries,
    })
}

/// One PUT entry writing `resource` at `url`.
fn put_entry(url: &str, resource: Value) -> Value {
    json!({
        "request": { "method": "PUT", "url": url },
        "resource": resource,
    })
}

/// A transaction Bundle POSTed to the base reaches HFS, comes back as a
/// `transaction-response` Bundle, and every entry lands.
#[tokio::test]
async fn transaction_bundle_lands_every_entry() {
    let (router, _db) = build_router();
    let bundle = transaction_of(vec![
        put_entry(
            "Patient/t1",
            json!({ "resourceType": "Patient", "id": "t1", "name": [{ "family": "Transaction" }] }),
        ),
        put_entry(
            "Observation/t1-weight",
            json!({
                "resourceType": "Observation",
                "id": "t1-weight",
                "status": "final",
                "code": { "text": "Weight" },
                "subject": { "reference": "Patient/t1" },
            }),
        ),
    ]);

    let (status, body) = send(&router, "POST", "/", Some(bundle)).await;

    assert_eq!(status, StatusCode::OK, "body: {body}");
    assert_eq!(body["type"], "transaction-response");
    let entry_statuses: Vec<&str> = body["entry"]
        .as_array()
        .unwrap_or_else(|| panic!("transaction-response without entries: {body}"))
        .iter()
        .map(|entry| entry["response"]["status"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(entry_statuses.len(), 2, "body: {body}");
    for entry_status in &entry_statuses {
        assert!(
            entry_status.starts_with("200") || entry_status.starts_with("201"),
            "transaction entry failed: {entry_status} in {body}"
        );
    }
    let (patient_status, _) = send(&router, "GET", "/Patient/t1", None).await;
    let (observation_status, _) = send(&router, "GET", "/Observation/t1-weight", None).await;
    assert_eq!(patient_status, StatusCode::OK);
    assert_eq!(observation_status, StatusCode::OK);
}

/// A transaction with one entry HFS refuses lands nothing: the whole Bundle
/// is rolled back, so a client can write a batch whose resources reference
/// each other and never leave a dangling reference behind. The refusal is a
/// `400` carrying an OperationOutcome.
#[tokio::test]
async fn transaction_with_one_refused_entry_lands_nothing() {
    let (router, _db) = build_router();
    let bundle = transaction_of(vec![
        put_entry(
            "Patient/t2",
            json!({ "resourceType": "Patient", "id": "t2", "name": [{ "family": "Rolled" }] }),
        ),
        // The resource is not of the type the entry's url names: HFS refuses the entry.
        put_entry(
            "Patient/t3",
            json!({ "resourceType": "Observation", "id": "t3", "status": "final", "code": { "text": "Back" } }),
        ),
    ]);

    let (status, body) = send(&router, "POST", "/", Some(bundle)).await;

    // The refusal is a 400 for the bundle with one OperationOutcome saying
    // why: what `fhir-r4`'s `BundleRefused` decodes and every entry reports.
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "a transaction with a refused entry must fail as a whole: {body}"
    );
    assert_eq!(body["resourceType"], "OperationOutcome", "body: {body}");
    assert!(
        body["issue"]
            .as_array()
            .is_some_and(|issues| !issues.is_empty()),
        "the refusal names no issue: {body}"
    );
    let (patient_status, patient) = send(&router, "GET", "/Patient/t2", None).await;
    assert_eq!(
        patient_status,
        StatusCode::NOT_FOUND,
        "the good entry landed despite the refused one: {patient}"
    );
}
