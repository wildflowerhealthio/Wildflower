//! End-to-end integration tests for the apps slice. Exercises the single
//! `/apps` router through `tower::ServiceExt::oneshot` so a regression in the
//! wire contract — status codes, JSON shapes, and the launch target a loopback
//! `204` routes to the on-device webview handle — fails the test rather than
//! relying on unit-level handler coverage.

use std::sync::Arc;

use apps_rust::domain::AppsError;
use apps_rust::ports::{LaunchContextMinter, NoAppLaunchScopes};
use apps_rust::{setup_apps, Apps, AppsConfig};
use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use serde_json::Value;
use tower::ServiceExt;
use url::Url;

use scope_capabilities_rust::ScopeClaims;
use shared_structures_rust::test_utils::RecordingStubWebviewHandle;

/// Insert the owner `ScopeClaims` the host's bearer gate places in the request
/// extensions before a scope-gated `/apps` handler reads them — `wildflower/*.cruds`
/// covers every `wildflower/Apps.<perm>`, and the `wildflower/launch` known scope
/// (not covered by the wildcard) satisfies the launch umbrella. Every request
/// builder below carries it so these end-to-end tests exercise the wire contract
/// without re-mounting the host's gate.
fn with_owner_claims(mut req: Request<Body>) -> Request<Body> {
    req.extensions_mut().insert(ScopeClaims::new(Some(
        "wildflower/*.cruds wildflower/launch".to_owned(),
    )));
    req
}

/// A [`LaunchContextMinter`] answering `launch-for-{client_id}`, standing in
/// for the host's gatekeeper-backed one.
struct NamedLaunchContextMinter;

impl LaunchContextMinter for NamedLaunchContextMinter {
    fn mint_launch_context(&self, client_id: &str) -> Result<String, AppsError> {
        Ok(format!("launch-for-{client_id}"))
    }
}

/// Spin up the slice plus the recording on-device webview handle, so a launch
/// test can assert the URL a loopback launch routes to it.
///
/// No per-app SMART launch scopes ([`NoAppLaunchScopes`]); launches are minted
/// by [`NamedLaunchContextMinter`].
fn spin_up_with_handle() -> (Apps, Arc<RecordingStubWebviewHandle>) {
    let pool = persistence_rust::open_in_memory_pool().expect("open in-memory diesel pool");
    let config = AppsConfig {
        public_origin: Url::parse("https://dev1.example.com").expect("valid public origin"),
    };
    let handle = Arc::new(RecordingStubWebviewHandle::default());
    let apps = setup_apps(
        pool,
        &config,
        handle.clone(),
        Arc::new(NoAppLaunchScopes),
        Arc::new(NamedLaunchContextMinter),
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
    with_owner_claims(Request::get(uri).body(Body::empty()).expect("build"))
}

/// A create — `POST /apps` as JSON.
fn post_create(name: &str, url: &str, requires_tunnel: bool) -> Request<Body> {
    post_json(
        "/apps",
        serde_json::json!({ "name": name, "url": url, "requiresTunnel": requires_tunnel }),
    )
}

fn post_json(uri: &str, body: serde_json::Value) -> Request<Body> {
    with_owner_claims(
        Request::post(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .expect("build"),
    )
}

fn put(uri: &str, body: serde_json::Value) -> Request<Body> {
    with_owner_claims(
        Request::put(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .expect("build"),
    )
}

fn delete(uri: &str) -> Request<Body> {
    with_owner_claims(Request::delete(uri).body(Body::empty()).expect("build"))
}

/// A launch request — `POST /apps/{id}` with an empty body.
fn launch(uri: &str) -> Request<Body> {
    with_owner_claims(Request::post(uri).body(Body::empty()).expect("build"))
}

/// Fresh-install seed: every code-defined default app present in display order.
#[tokio::test]
async fn fresh_install_lists_the_default_set() {
    let apps = spin_up();
    let res = apps
        .router
        .clone()
        .oneshot(get("/apps"))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res.into_body()).await;
    let ids: Vec<&str> = body
        .as_array()
        .expect("array")
        .iter()
        .map(|v| v["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        vec![
            "growth-chart",
            "medication-viewer",
            "precise-hbr",
            "medications-app",
            "web-server-docs",
            "importer-app",
            "ohif-viewer",
            "lifting",
            "health-viewer-app",
        ],
    );
}

/// A loopback launch of a seeded SMART app hands the on-device webview its
/// template with the public origin and a launch minted for its OAuth client.
#[tokio::test]
async fn a_smart_app_launch_carries_a_launch_minted_for_its_client() {
    let (apps, handle) = spin_up_with_handle();
    let launch_res = apps
        .router
        .clone()
        .oneshot(launch("/apps/growth-chart"))
        .await
        .expect("oneshot");
    assert_eq!(launch_res.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        handle.0.lock().expect("handle mutex").clone(),
        vec![
            "https://examples.smarthealthit.org/growth-chart-app/launch.html\
             ?iss=https://dev1.example.com/fhir-r4&launch=launch-for-growth_chart"
                .to_string()
        ],
    );
}

/// An app created through the admin surface shows up immediately in the public
/// list (one shared state) and round-trips through launch + delete.
#[tokio::test]
async fn app_round_trip() {
    let (apps, handle) = spin_up_with_handle();
    let router = apps.router.clone();
    let create_res = router
        .clone()
        .oneshot(post_create(
            "Round Trip",
            "https://example.com/launch",
            false,
        ))
        .await
        .expect("oneshot");
    assert_eq!(create_res.status(), StatusCode::OK);
    let created = body_json(create_res.into_body()).await;
    let id = created["id"].as_str().expect("id").to_string();
    assert!(!id.is_empty());

    let list_res = router.clone().oneshot(get("/apps")).await.expect("oneshot");
    let list = body_json(list_res.into_body()).await;
    let found = list
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == serde_json::Value::String(id.clone()))
        .expect("created row visible through the list");
    assert_eq!(found["name"], "Round Trip");
    assert_eq!(found["url"], "https://example.com/launch");

    let launch_res = router
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

    let delete_res = router
        .clone()
        .oneshot(delete(&format!("/apps/{id}")))
        .await
        .expect("oneshot");
    assert_eq!(delete_res.status(), StatusCode::NO_CONTENT);

    let list_res = router.clone().oneshot(get("/apps")).await.expect("oneshot");
    let list = body_json(list_res.into_body()).await;
    assert!(
        list.as_array()
            .unwrap()
            .iter()
            .all(|v| v["id"] != serde_json::Value::String(id.clone())),
        "deleted row still listed",
    );
}

/// A seeded app's content (name / url) is replaceable through `PUT /apps/{id}`;
/// the edit persists into the public list and the by-id read. (`onHomescreen` is
/// not content — that's `PUT /home-screen`.)
#[tokio::test]
async fn seeded_app_is_fully_editable() {
    let apps = spin_up();
    let router = apps.router.clone();
    let put_res = router
        .clone()
        .oneshot(put(
            "/apps/growth-chart",
            serde_json::json!({
                "name": "Renamed Chart",
                "url": "https://example.com/replacement",
                "requiresTunnel": true,
            }),
        ))
        .await
        .expect("oneshot");
    assert_eq!(put_res.status(), StatusCode::OK);
    let body = body_json(put_res.into_body()).await;
    assert_eq!(body["name"], "Renamed Chart");
    assert_eq!(body["url"], "https://example.com/replacement");

    let list_res = router.clone().oneshot(get("/apps")).await.expect("oneshot");
    let list = body_json(list_res.into_body()).await;
    let row = list
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == "growth-chart")
        .expect("growth-chart in list");
    assert_eq!(row["name"], "Renamed Chart");
    assert_eq!(row["url"], "https://example.com/replacement");

    let detail_res = router
        .clone()
        .oneshot(get("/apps/growth-chart"))
        .await
        .expect("oneshot");
    assert_eq!(detail_res.status(), StatusCode::OK);
    let detail = body_json(detail_res.into_body()).await;
    assert_eq!(
        detail["url"], "https://example.com/replacement",
        "the by-id read carries the replaced url template",
    );
}

/// `PUT /home-screen` atomically reorders + disables and persists — the
/// positions come back a dense `0..n` permutation (no ties).
#[tokio::test]
async fn home_screen_reorders_and_disables_an_app() {
    let apps = spin_up();
    let router = apps.router.clone();
    // Move lifting to the front and disable it; keep the rest in order.
    let body = serde_json::json!([
        { "id": "lifting", "onHomescreen": false },
        { "id": "growth-chart", "onHomescreen": true },
        { "id": "medication-viewer", "onHomescreen": true },
        { "id": "precise-hbr", "onHomescreen": true },
        { "id": "medications-app", "onHomescreen": true },
        { "id": "web-server-docs", "onHomescreen": true },
        { "id": "importer-app", "onHomescreen": true },
        { "id": "ohif-viewer", "onHomescreen": true },
        { "id": "health-viewer-app", "onHomescreen": true },
    ]);
    let res = router
        .clone()
        .oneshot(put("/home-screen", body))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);

    // The list now reflects the new order and the disabled flag.
    let list_res = router.clone().oneshot(get("/apps")).await.expect("oneshot");
    let list = body_json(list_res.into_body()).await;
    let arr = list.as_array().unwrap();
    let ids: Vec<&str> = arr.iter().map(|v| v["id"].as_str().unwrap()).collect();
    assert_eq!(
        ids,
        vec![
            "lifting",
            "growth-chart",
            "medication-viewer",
            "precise-hbr",
            "medications-app",
            "web-server-docs",
            "importer-app",
            "ohif-viewer",
            "health-viewer-app",
        ],
    );
    let lifting = arr.iter().find(|v| v["id"] == "lifting").unwrap();
    assert_eq!(lifting["onHomescreen"], false);
}

/// A deleted seeded app stays deleted (migration runner seeds once).
#[tokio::test]
async fn deleted_seeded_app_stays_deleted() {
    let apps = spin_up();
    let router = apps.router.clone();
    let res = router
        .clone()
        .oneshot(delete("/apps/growth-chart"))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

    let list_res = router.clone().oneshot(get("/apps")).await.expect("oneshot");
    let list = body_json(list_res.into_body()).await;
    assert!(
        list.as_array()
            .unwrap()
            .iter()
            .all(|v| v["id"] != "growth-chart"),
        "growth-chart reappeared after deletion: {list}",
    );
}

/// Launch-path defence-in-depth: a `javascript:` URL is rejected on write.
#[tokio::test]
async fn create_rejects_javascript_url() {
    let apps = spin_up();
    let res = apps
        .router
        .clone()
        .oneshot(post_create("Bad", "javascript:alert(1)", false))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let body = body_json(res.into_body()).await;
    assert_eq!(body["error"], "InvalidUrl");
}
