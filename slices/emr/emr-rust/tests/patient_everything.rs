//! End-to-end tests for the `$everything` override, exercised through the real
//! router `setup_fhir_r4` builds (HFS create/read/type-level search + our
//! in-memory subject match + merge), with HFS auth off (`jwks_url: None`).
//! Covers patient-first ordering, the multi-type related set
//! (`Observation` + `MedicationRequest`), `_count` truncation, and `404` for a
//! missing patient.

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
    let dir = std::env::temp_dir().join(format!("emr-rust-everything-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp dir");

    let runtime = ServerRuntimeConfig {
        loopback_base_url: "http://127.0.0.1:8080".parse().expect("parse loopback url"),
        app_data_dir: dir.clone(),
    };
    let config = EmrConfig {
        log_level: "error".to_string(),
        db_file_path: dir.join("health-data.sqlite"),
        jwks_url: None,
    };

    let router = setup_fhir_r4(&runtime, &config).expect("setup_fhir_r4");
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

/// PUT (create-with-id) a minimal Patient, asserting the write succeeded.
async fn put_patient(router: &Router, id: &str) {
    let (status, body) = send(
        router,
        "PUT",
        &format!("/fhir-r4/Patient/{id}"),
        Some(json!({ "resourceType": "Patient", "id": id })),
    )
    .await;
    assert!(
        status.is_success(),
        "PUT Patient/{id} failed: {status} {body}"
    );
}

/// PUT (create-with-id) a minimal Observation referencing `Patient/{subject}`.
async fn put_observation(router: &Router, id: &str, subject: &str) {
    let (status, body) = send(
        router,
        "PUT",
        &format!("/fhir-r4/Observation/{id}"),
        Some(json!({
            "resourceType": "Observation",
            "id": id,
            "status": "final",
            "code": { "text": "test" },
            "subject": { "reference": format!("Patient/{subject}") },
        })),
    )
    .await;
    assert!(
        status.is_success(),
        "PUT Observation/{id} failed: {status} {body}"
    );
}

/// PUT (create-with-id) a minimal `MedicationRequest` referencing
/// `Patient/{subject}` (via its `subject` element, like `Observation`).
async fn put_medication_request(router: &Router, id: &str, subject: &str) {
    let (status, body) = send(
        router,
        "PUT",
        &format!("/fhir-r4/MedicationRequest/{id}"),
        Some(json!({
            "resourceType": "MedicationRequest",
            "id": id,
            "status": "active",
            "intent": "order",
            "medicationCodeableConcept": { "text": "test med" },
            "subject": { "reference": format!("Patient/{subject}") },
        })),
    )
    .await;
    assert!(
        status.is_success(),
        "PUT MedicationRequest/{id} failed: {status} {body}"
    );
}

#[tokio::test]
async fn returns_bundle_patient_first_then_referencing_observations() {
    let (router, _db) = build_router();

    // Two patients; only p1 is the target. Three observations reference p1,
    // one references p2 — the bundle should carry p1 + its three.
    put_patient(&router, "p1").await;
    put_patient(&router, "p2").await;
    put_observation(&router, "o1", "p1").await;
    put_observation(&router, "o2", "p1").await;
    put_observation(&router, "o3", "p1").await;
    put_observation(&router, "o-other", "p2").await;

    let (status, bundle) = send(&router, "GET", "/fhir-r4/Patient/p1/$everything", None).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(bundle["resourceType"], "Bundle");
    assert_eq!(bundle["type"], "searchset");
    assert_eq!(bundle["total"], 4);

    let entries = bundle["entry"].as_array().expect("entry array");
    assert_eq!(entries.len(), 4);

    // Primary patient first.
    assert_eq!(entries[0]["resource"]["resourceType"], "Patient");
    assert_eq!(entries[0]["resource"]["id"], "p1");

    // Then exactly the three observations referencing p1.
    let mut observation_ids: Vec<String> = entries[1..]
        .iter()
        .map(|entry| {
            assert_eq!(entry["resource"]["resourceType"], "Observation");
            entry["resource"]["id"]
                .as_str()
                .expect("observation id")
                .to_string()
        })
        .collect();
    observation_ids.sort();
    assert_eq!(observation_ids, vec!["o1", "o2", "o3"]);

    // Every entry is a search match.
    for entry in entries {
        assert_eq!(entry["search"]["mode"], "match");
    }

    // Self link points back at the operation.
    let links = bundle["link"].as_array().expect("link array");
    assert!(links.iter().any(|link| link["relation"] == "self"));
}

#[tokio::test]
async fn bundle_includes_multiple_related_types_for_the_target_patient() {
    let (router, _db) = build_router();

    // p1 owns an Observation and a MedicationRequest; p2 owns one of each too,
    // which must not leak into p1's `$everything`.
    put_patient(&router, "p1").await;
    put_patient(&router, "p2").await;
    put_observation(&router, "o1", "p1").await;
    put_medication_request(&router, "m1", "p1").await;
    put_observation(&router, "o-other", "p2").await;
    put_medication_request(&router, "m-other", "p2").await;

    let (status, bundle) = send(&router, "GET", "/fhir-r4/Patient/p1/$everything", None).await;

    assert_eq!(status, StatusCode::OK);
    let entries = bundle["entry"].as_array().expect("entry array");

    // Patient first, then exactly p1's Observation + MedicationRequest.
    assert_eq!(entries[0]["resource"]["resourceType"], "Patient");
    assert_eq!(entries[0]["resource"]["id"], "p1");

    let mut related: Vec<(String, String)> = entries[1..]
        .iter()
        .map(|entry| {
            let resource = &entry["resource"];
            (
                resource["resourceType"]
                    .as_str()
                    .expect("resourceType")
                    .to_string(),
                resource["id"].as_str().expect("id").to_string(),
            )
        })
        .collect();
    related.sort();
    assert_eq!(
        related,
        vec![
            ("MedicationRequest".to_string(), "m1".to_string()),
            ("Observation".to_string(), "o1".to_string()),
        ]
    );
    assert_eq!(bundle["total"], 3);

    // Every entry is a search match.
    for entry in entries {
        assert_eq!(entry["search"]["mode"], "match");
    }
}

#[tokio::test]
async fn count_truncates_related_observations() {
    let (router, _db) = build_router();

    put_patient(&router, "p1").await;
    put_observation(&router, "o1", "p1").await;
    put_observation(&router, "o2", "p1").await;
    put_observation(&router, "o3", "p1").await;

    let (status, bundle) = send(
        &router,
        "GET",
        "/fhir-r4/Patient/p1/$everything?_count=2",
        None,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let entries = bundle["entry"].as_array().expect("entry array");
    // Primary patient + 2 of the 3 observations.
    assert_eq!(entries.len(), 3);
    assert_eq!(bundle["total"], 3);
    assert_eq!(entries[0]["resource"]["resourceType"], "Patient");
    for entry in &entries[1..] {
        assert_eq!(entry["resource"]["resourceType"], "Observation");
    }
}

/// Regression: a real client sends `Accept-Encoding: gzip, …`. Our handler
/// re-drives `hfs_router` in-process, whose `CompressionLayer` would compress
/// the delegated `read`/`search` sub-responses if the header were forwarded,
/// leaving `read_json` with a compressed body it can't parse (the route 500'd
/// with "failed to parse sub-response JSON"). `delegate_get` must strip
/// `Accept-Encoding` so the sub-responses come back as plain JSON.
#[tokio::test]
async fn succeeds_when_client_advertises_compression() {
    let (router, _db) = build_router();

    put_patient(&router, "p1").await;
    put_observation(&router, "o1", "p1").await;

    let request = Request::builder()
        .method("GET")
        .uri("/fhir-r4/Patient/p1/$everything")
        .header("accept", "application/fhir+json")
        .header("accept-encoding", "gzip, deflate, br")
        .body(Body::empty())
        .expect("build request");
    let response = router
        .clone()
        .oneshot(request)
        .await
        .expect("router is infallible");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read response body");
    let bundle: Value = serde_json::from_slice(&bytes).expect("parse response JSON");

    assert_eq!(status, StatusCode::OK, "body: {bundle}");
    assert_eq!(bundle["resourceType"], "Bundle");
    assert_eq!(bundle["type"], "searchset");
    assert_eq!(bundle["total"], 2);
    assert_eq!(bundle["entry"][0]["resource"]["resourceType"], "Patient");
    assert_eq!(bundle["entry"][0]["resource"]["id"], "p1");
    assert_eq!(
        bundle["entry"][1]["resource"]["resourceType"],
        "Observation"
    );
}

/// Regression: a client may content-negotiate for XML (`Accept:
/// application/fhir+xml`), which HFS could honor on the delegated sub-response —
/// leaving `read_json` an XML body it can't parse (a `500`). `delegate_get` must
/// pin the sub-request's `Accept` to FHIR JSON (dropping the caller's), so the
/// operation still yields a JSON Bundle regardless of the caller's `Accept`.
#[tokio::test]
async fn succeeds_when_client_requests_xml() {
    let (router, _db) = build_router();

    put_patient(&router, "p1").await;
    put_observation(&router, "o1", "p1").await;

    let request = Request::builder()
        .method("GET")
        .uri("/fhir-r4/Patient/p1/$everything")
        .header("accept", "application/fhir+xml")
        .body(Body::empty())
        .expect("build request");
    let response = router
        .clone()
        .oneshot(request)
        .await
        .expect("router is infallible");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read response body");
    let bundle: Value = serde_json::from_slice(&bytes).expect("parse response JSON");

    assert_eq!(status, StatusCode::OK, "body: {bundle}");
    assert_eq!(bundle["resourceType"], "Bundle");
    assert_eq!(bundle["type"], "searchset");
    assert_eq!(bundle["total"], 2);
    assert_eq!(bundle["entry"][0]["resource"]["resourceType"], "Patient");
    assert_eq!(bundle["entry"][0]["resource"]["id"], "p1");
}

#[tokio::test]
async fn missing_patient_yields_404() {
    let (router, _db) = build_router();

    let (status, _body) = send(
        &router,
        "GET",
        "/fhir-r4/Patient/does-not-exist/$everything",
        None,
    )
    .await;

    assert_eq!(status, StatusCode::NOT_FOUND);
}
