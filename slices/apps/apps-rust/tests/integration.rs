//! End-to-end integration tests for the apps slice. Exercises both routers
//! through `tower::ServiceExt::oneshot` so a regression in the wire
//! contract — status codes, JSON shapes, the `Location` header on launch
//! — fails the test rather than relying on unit-level handler coverage.
//!
//! Mirrors `gatekeeper-rust/tests/integration.rs`: one shared in-memory DB
//! shared between the public and admin routers (so a custom row created
//! through the admin one is immediately visible through the public one),
//! one router-per-call (each `oneshot` consumes the router instance), and
//! `serde_json::from_slice` for body assertions.

use apps_rust::{setup_apps, Apps, AppsConfig};
use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use persistence_rust::Connection;
use serde_json::Value;
use tower::ServiceExt;

const LOOPBACK_ORIGIN: &str = "http://127.0.0.1:8080";

fn spin_up() -> Apps {
    let db = Connection::open_in_memory().expect("open shared db");
    let config = AppsConfig {
        loopback_origin: LOOPBACK_ORIGIN.to_string(),
    };
    setup_apps(db, &config).expect("setup_apps")
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

/// The list endpoint returns at least every bundled app on a fresh install.
#[tokio::test]
async fn fresh_install_lists_every_bundled_app() {
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
        "fhir-sharing",
        "patient-browser",
        "api-view",
        "api-docs",
        "growth-chart",
        "medication-viewer",
    ] {
        assert!(
            ids.contains(&expected),
            "missing seeded id {expected} in {ids:?}"
        );
    }
}

/// The two routers share the same `AppsState` — a custom row created
/// through the admin router shows up immediately through the public one.
#[tokio::test]
async fn custom_apps_round_trip_between_routers() {
    let apps = spin_up();
    // create through admin
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
    assert!(id.starts_with("custom-"));

    // visible through public list
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

    // launch through public router
    let launch_res = apps
        .public_router
        .clone()
        .oneshot(get(&format!("/apps/{id}")))
        .await
        .expect("oneshot");
    assert_eq!(launch_res.status(), StatusCode::FOUND);
    assert_eq!(
        launch_res
            .headers()
            .get("location")
            .expect("location")
            .to_str()
            .unwrap(),
        "https://example.com/launch",
    );

    // delete through admin
    let delete_res = apps
        .admin_router
        .clone()
        .oneshot(delete(&format!("/apps/{id}")))
        .await
        .expect("oneshot");
    assert_eq!(delete_res.status(), StatusCode::OK);
    let body = body_json(delete_res.into_body()).await;
    assert_eq!(body["deleted"], true);

    // gone from the list
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

/// Toggling a bundled app's `enabled` flag persists across reads.
#[tokio::test]
async fn bundled_app_disable_persists() {
    let apps = spin_up();
    let res = apps
        .admin_router
        .clone()
        .oneshot(patch(
            "/apps/patient-browser",
            serde_json::json!({ "enabled": false }),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res.into_body()).await;
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
        .find(|v| v["id"] == "patient-browser")
        .expect("patient-browser in list");
    assert_eq!(row["enabled"], false, "disable persisted into list output");
}

/// Renaming a bundled app — even one we just disabled — must 403.
#[tokio::test]
async fn bundled_app_rename_is_403() {
    let apps = spin_up();
    let res = apps
        .admin_router
        .clone()
        .oneshot(patch(
            "/apps/api-docs",
            serde_json::json!({ "name": "Hijack" }),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let body = body_json(res.into_body()).await;
    assert_eq!(body["error"], "BundledAppImmutable");
    assert_eq!(body["id"], "api-docs");
}

/// Launch path defence-in-depth: the create endpoint rejects a bad URL on
/// write so a row whose `LaunchApp` would 302 to `javascript:` etc. can't
/// be persisted.
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
