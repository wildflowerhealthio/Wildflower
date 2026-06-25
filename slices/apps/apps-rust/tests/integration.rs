//! End-to-end integration tests for the apps slice. Exercises both routers
//! through `tower::ServiceExt::oneshot` so a regression in the wire
//! contract — status codes, JSON shapes, and the launch target a loopback
//! `204` routes to the on-device webview handle — fails the test rather than
//! relying on unit-level handler coverage.
//!
//! Mirrors `gatekeeper-rust/tests/integration.rs`: one shared in-memory DB
//! shared between the public and admin routers (so a row created or
//! patched through the admin one is immediately visible through the public
//! one).

use std::sync::Arc;

use apps_rust::{setup_apps, Apps, AppsConfig};
use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use persistence_rust::Connection;
use serde_json::Value;
use shared_structures_rust::tunnel_service::OfflineTunnel;
use tower::ServiceExt;

use shared_structures_rust::test_utils::RecordingStubWebviewHandle;

const LOOPBACK_ORIGIN: &str = "http://127.0.0.1:8080";
const LOOPBACK_HOST: &str = "127.0.0.1";

/// Spin up the slice plus the recording on-device webview handle, so a launch
/// test can assert the URL a loopback launch routes to it.
///
/// No tunnel in the integration harness: `requires_tunnel` launches fall back to
/// loopback + `?tunnel=unavailable`. A loopback launch `204`s and routes the
/// resolved URL to the handle (a forwarded caller would `302` instead, but the
/// harness only issues loopback launches).
fn spin_up_with_handle() -> (Apps, Arc<RecordingStubWebviewHandle>) {
    let db = Connection::open_in_memory().expect("open shared db");
    let config = AppsConfig {
        loopback_origin: LOOPBACK_ORIGIN.to_string(),
        internal_apps_loopback_host: LOOPBACK_HOST.to_string(),
    };
    let handle = Arc::new(RecordingStubWebviewHandle::default());
    let apps = setup_apps(
        db,
        &config,
        Arc::new(OfflineTunnel::new(LOOPBACK_ORIGIN)),
        handle.clone(),
    )
    .expect("setup_apps");
    (apps, handle)
}

fn spin_up() -> Apps {
    spin_up_with_handle().0
}

async fn body_json(body: Body) -> Value {
    let bytes = to_bytes(body, usize::MAX).await.expect("body");
    serde_json::from_slice(&bytes).expect("json")
}

fn get(uri: &str) -> Request<Body> {
    Request::get(uri).body(Body::empty()).expect("build")
}

fn post(uri: &str, body: serde_json::Value) -> Request<Body> {
    Request::post(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .expect("build")
}

fn patch(uri: &str, body: serde_json::Value) -> Request<Body> {
    Request::patch(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .expect("build")
}

fn delete(uri: &str) -> Request<Body> {
    Request::delete(uri).body(Body::empty()).expect("build")
}

/// A launch request — `POST /apps/{id}` with an empty body (the launch carries
/// no payload; the id is in the path).
fn launch(uri: &str) -> Request<Body> {
    Request::post(uri).body(Body::empty()).expect("build")
}

/// Fresh-install seed: every code-defined default app present and
/// FHIR Sharing absent (tunnel control is no longer routed through apps).
#[tokio::test]
async fn fresh_install_lists_the_default_set_without_fhir_sharing() {
    let apps = spin_up();
    let res = apps
        .public_router
        .clone()
        .oneshot(get("/apps"))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res.into_body()).await;
    let arr = body.as_array().expect("array");
    let ids: Vec<&str> = arr.iter().map(|v| v["id"].as_str().unwrap()).collect();
    for expected in [
        "patient-browser",
        "api-view",
        "api-docs",
        "growth-chart",
        "medication-viewer",
    ] {
        assert!(
            ids.contains(&expected),
            "missing seeded id {expected} in {ids:?}",
        );
    }
    assert!(
        !ids.contains(&"fhir-sharing"),
        "fhir-sharing should be gone from the seed: {ids:?}",
    );
}

/// The two routers share the same `AppsState` — a row created through the
/// admin router shows up immediately through the public one.
#[tokio::test]
async fn apps_round_trip_between_routers() {
    let (apps, handle) = spin_up_with_handle();
    let create_res = apps
        .admin_router
        .clone()
        .oneshot(post(
            "/apps",
            serde_json::json!({
                "name": "Round Trip",
                "url": "https://example.com/launch",
                "requiresTunnel": false,
            }),
        ))
        .await
        .expect("oneshot");
    assert_eq!(create_res.status(), StatusCode::OK);
    let created = body_json(create_res.into_body()).await;
    let id = created["id"].as_str().expect("id").to_string();
    assert!(!id.is_empty());

    let list_res = apps
        .public_router
        .clone()
        .oneshot(get("/apps"))
        .await
        .expect("oneshot");
    let list = body_json(list_res.into_body()).await;
    let found = list
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == serde_json::Value::String(id.clone()))
        .expect("created row visible through public list");
    assert_eq!(found["name"], "Round Trip");

    let launch_res = apps
        .public_router
        .clone()
        .oneshot(launch(&format!("/apps/{id}")))
        .await
        .expect("oneshot");
    assert_eq!(launch_res.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        handle.0.lock().expect("handle mutex").clone(),
        vec!["https://example.com/launch".to_string()],
        "a loopback launch routes the resolved URL to the on-device webview handle",
    );

    let delete_res = apps
        .admin_router
        .clone()
        .oneshot(delete(&format!("/apps/{id}")))
        .await
        .expect("oneshot");
    assert_eq!(delete_res.status(), StatusCode::OK);
    let body = body_json(delete_res.into_body()).await;
    assert_eq!(body["deleted"], true);

    let list_res = apps
        .public_router
        .clone()
        .oneshot(get("/apps"))
        .await
        .expect("oneshot");
    let list = body_json(list_res.into_body()).await;
    assert!(
        list.as_array()
            .unwrap()
            .iter()
            .all(|v| v["id"] != serde_json::Value::String(id.clone())),
        "deleted row still listed",
    );
}

/// Every external app is first-class: rename, URL swap, and disable land
/// successfully and persist into the public list.
#[tokio::test]
async fn seeded_external_app_is_fully_editable() {
    let apps = spin_up();
    let patch_res = apps
        .admin_router
        .clone()
        .oneshot(patch(
            "/apps/api-docs",
            serde_json::json!({
                "name": "Renamed Docs",
                "url": "https://example.com/replacement",
                "enabled": false,
            }),
        ))
        .await
        .expect("oneshot");
    assert_eq!(patch_res.status(), StatusCode::OK);
    let body = body_json(patch_res.into_body()).await;
    assert_eq!(body["name"], "Renamed Docs");
    assert_eq!(body["url"], "https://example.com/replacement");
    assert_eq!(body["enabled"], false);

    let list_res = apps
        .public_router
        .clone()
        .oneshot(get("/apps"))
        .await
        .expect("oneshot");
    let list = body_json(list_res.into_body()).await;
    let row = list
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == "api-docs")
        .expect("api-docs in list");
    assert_eq!(row["name"], "Renamed Docs");
    // `url` doesn't ride on the public list; the edited URL round-trips
    // through the admin PATCH response above, which is the contract clients
    // rely on.
    assert!(row.get("url").is_none(), "GET /apps must not expose url");
}

/// Internal apps appear in the public list under their id without a
/// `url` field (the launch endpoint resolves the per-caller target — the
/// catalogue stays provenance-free). The admin surface, which only
/// operates on the externals table, cannot reach them (a PATCH 404s).
#[tokio::test]
async fn internal_app_appears_in_public_list_but_is_not_editable() {
    let apps = spin_up();
    let list_res = apps
        .public_router
        .clone()
        .oneshot(get("/apps"))
        .await
        .expect("oneshot");
    let list = body_json(list_res.into_body()).await;
    let row = list
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == "patient-browser")
        .expect("patient-browser in list");
    assert_eq!(row["name"], "Patient Browser");
    assert!(
        row.get("url").is_none(),
        "GET /apps must not expose url, got {row}",
    );

    let patch_res = apps
        .admin_router
        .clone()
        .oneshot(patch(
            "/apps/patient-browser",
            serde_json::json!({ "name": "tampered" }),
        ))
        .await
        .expect("oneshot");
    assert_eq!(patch_res.status(), StatusCode::NOT_FOUND);
}

/// A loopback launch of an internal app `204`s and routes its dedicated
/// loopback origin (`http://{host}:{port}/`, fixed, no `{origin}` substitution)
/// to the on-device webview handle.
#[tokio::test]
async fn internal_app_launches_to_its_dedicated_loopback_origin() {
    let (apps, handle) = spin_up_with_handle();
    let res = apps
        .public_router
        .clone()
        .oneshot(launch("/apps/patient-browser"))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        handle.0.lock().expect("handle mutex").clone(),
        vec!["http://127.0.0.1:8081/".to_string()],
    );
}

/// Every app is first-class — including for deletion. After a seeded id is
/// deleted it doesn't reappear on the next list (the migration runner only
/// seeds it once per database).
#[tokio::test]
async fn deleted_seeded_app_stays_deleted() {
    let apps = spin_up();
    let res = apps
        .admin_router
        .clone()
        .oneshot(delete("/apps/api-docs"))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);

    let list_res = apps
        .public_router
        .clone()
        .oneshot(get("/apps"))
        .await
        .expect("oneshot");
    let list = body_json(list_res.into_body()).await;
    assert!(
        list.as_array()
            .unwrap()
            .iter()
            .all(|v| v["id"] != "api-docs"),
        "api-docs reappeared after deletion: {list}",
    );
}

/// Launch-path defence-in-depth: a `javascript:` URL is rejected on write,
/// so a row that would 302 to `javascript:` can never land.
#[tokio::test]
async fn create_rejects_javascript_url() {
    let apps = spin_up();
    let res = apps
        .admin_router
        .clone()
        .oneshot(post(
            "/apps",
            serde_json::json!({
                "name": "Bad",
                "url": "javascript:alert(1)",
                "requiresTunnel": false,
            }),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let body = body_json(res.into_body()).await;
    assert_eq!(body["error"], "InvalidUrl");
}
