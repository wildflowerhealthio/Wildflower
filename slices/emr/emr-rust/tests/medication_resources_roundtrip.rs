//! Backend round-trip coverage for the medication resource types added to the
//! `fhir-r4` TypeScript client surface (issue #334). HFS is a general FHIR R4
//! store, so `setup_fhir_r4` accepts any R4 resource type; these tests prove
//! that end-to-end for `MedicationRequest` and `MedicationDispense` by driving
//! the real router: PUT (create-with-id) then GET the same id back and assert
//! the resource survives the trip — including a `contained` Medication on the
//! request (the shape Rexall detail responses carry).

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
    let dir = std::env::temp_dir().join(format!("emr-rust-medication-{}-{n}", std::process::id()));
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

    // Auth is off here (jwks_url is None), so the revocation store is never
    // consulted — the always-allow double satisfies the signature without
    // standing up a database.
    let revocation_store = token_revocation_rust::RevocationStore::always_allow();
    let router = setup_fhir_r4(&runtime, &config, revocation_store).expect("setup_fhir_r4");
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

#[tokio::test]
async fn medication_request_with_contained_medication_round_trips() {
    let (router, _db) = build_router();

    // A MedicationRequest referencing a `#med` contained Medication (carrying a
    // code and form), plus a dosage instruction — the shape the Rexall
    // collector produces.
    let request = json!({
        "resourceType": "MedicationRequest",
        "id": "mr1",
        "status": "active",
        "intent": "order",
        "contained": [{
            "resourceType": "Medication",
            "id": "med",
            "code": { "text": "Atorvastatin 20mg tablet" },
            "form": { "text": "tablet" },
        }],
        "medicationReference": { "reference": "#med" },
        "subject": { "reference": "Patient/p1" },
        "authoredOn": "2026-01-02T03:04:05Z",
        "dosageInstruction": [{
            "text": "Take one tablet by mouth daily",
            "timing": { "repeat": { "frequency": 1, "period": 1, "periodUnit": "d" } },
        }],
        "dispenseRequest": {
            "numberOfRepeatsAllowed": 3,
            "quantity": { "value": 30, "unit": "tablet" },
            "expectedSupplyDuration": { "value": 30, "unit": "days", "system": "http://unitsofmeasure.org", "code": "d" },
        },
    });

    let (put_status, put_body) = send(
        &router,
        "PUT",
        "/fhir-r4/MedicationRequest/mr1",
        Some(request),
    )
    .await;
    assert!(
        put_status.is_success(),
        "PUT MedicationRequest failed: {put_status} {put_body}"
    );

    let (get_status, got) = send(&router, "GET", "/fhir-r4/MedicationRequest/mr1", None).await;
    assert_eq!(get_status, StatusCode::OK, "body: {got}");
    assert_eq!(got["resourceType"], "MedicationRequest");
    assert_eq!(got["id"], "mr1");
    assert_eq!(got["status"], "active");
    assert_eq!(got["intent"], "order");
    // The contained Medication survives the trip.
    assert_eq!(got["contained"][0]["resourceType"], "Medication");
    assert_eq!(got["contained"][0]["id"], "med");
    assert_eq!(got["medicationReference"]["reference"], "#med");
    assert_eq!(got["dispenseRequest"]["numberOfRepeatsAllowed"], 3);
}

#[tokio::test]
async fn medication_dispense_round_trips() {
    let (router, _db) = build_router();

    let dispense = json!({
        "resourceType": "MedicationDispense",
        "id": "md1",
        "status": "completed",
        "medicationCodeableConcept": { "text": "Atorvastatin 20mg tablet" },
        "subject": { "reference": "Patient/p1" },
        "quantity": { "value": 30, "unit": "tablet" },
        "whenHandedOver": "2026-01-03T09:00:00Z",
        "substitution": { "wasSubstituted": false },
    });

    let (put_status, put_body) = send(
        &router,
        "PUT",
        "/fhir-r4/MedicationDispense/md1",
        Some(dispense),
    )
    .await;
    assert!(
        put_status.is_success(),
        "PUT MedicationDispense failed: {put_status} {put_body}"
    );

    let (get_status, got) = send(&router, "GET", "/fhir-r4/MedicationDispense/md1", None).await;
    assert_eq!(get_status, StatusCode::OK, "body: {got}");
    assert_eq!(got["resourceType"], "MedicationDispense");
    assert_eq!(got["id"], "md1");
    assert_eq!(got["status"], "completed");
    assert_eq!(got["substitution"]["wasSubstituted"], false);
    assert_eq!(got["quantity"]["value"], 30);
}
