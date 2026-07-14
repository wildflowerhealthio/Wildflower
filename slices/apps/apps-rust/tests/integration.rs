//! End-to-end integration tests for the apps slice. Exercises the single
//! `/apps` router through `tower::ServiceExt::oneshot` so a regression in the
//! wire contract — status codes, JSON shapes, and the launch target a loopback
//! `204` routes to the on-device webview handle — fails the test rather than
//! relying on unit-level handler coverage.

use std::sync::Arc;

use apps_rust::{
    ports::{NoLaunchCookies, OwnerAuth, StubOwnerAuth},
    setup_apps, Apps, AppsConfig, SelfHostedAppsService,
};
use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use serde_json::Value;
use shared_structures_rust::tunnel_service::OfflineTunnel;
use shared_structures_server_rust::ProxyTable;
use tower::ServiceExt;
use url::Url;

use shared_structures_rust::test_utils::RecordingStubWebviewHandle;

const LOOPBACK_BASE_URL: &str = "http://127.0.0.1:8080/";

/// Spin up the slice plus the recording on-device webview handle, so a launch
/// test can assert the URL a loopback launch routes to it.
///
/// An allow-all owner gate (loopback launches succeed) and no tunnel (an
/// [`OfflineTunnel`]): a `requires_tunnel` launch would `503`, so the harness
/// only issues loopback launches of non-tunnel apps.
fn spin_up_with_handle() -> (Apps, Arc<RecordingStubWebviewHandle>) {
    let pool = persistence_rust::open_in_memory_pool().expect("open in-memory diesel pool");
    let config = AppsConfig {
        loopback_base_url: Url::parse(LOOPBACK_BASE_URL).expect("valid base url"),
    };
    let handle = Arc::new(RecordingStubWebviewHandle::default());
    // `StubOwnerAuth` is `#[deprecated]` to keep the no-op stub out of production
    // wiring; this allow-all owner is the sanctioned test use, so scope the
    // silence to exactly this construction rather than the whole crate.
    #[allow(deprecated)]
    let owner_auth: Arc<dyn OwnerAuth> = Arc::new(StubOwnerAuth::always_allowed());
    let tunnel = Arc::new(OfflineTunnel::new("http://127.0.0.1:8080"));
    // A throwaway apps dir + fresh proxy table back the self-hosted service the
    // slice now takes; the integration tests here don't exercise upload/serve, so
    // an empty dir is fine (it's left for the OS to reap).
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    let apps_dir = std::env::temp_dir().join(format!("wf-apps-int-{unique}"));
    std::fs::create_dir_all(&apps_dir).expect("create temp apps dir");
    let self_hosted = Arc::new(SelfHostedAppsService::new(
        &Url::parse(LOOPBACK_BASE_URL).expect("valid base url"),
        apps_dir,
        ProxyTable::new(),
        tunnel.clone(),
    ));
    let apps = setup_apps(
        pool,
        &config,
        tunnel,
        handle.clone(),
        owner_auth,
        self_hosted,
        Arc::new(NoLaunchCookies),
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

/// A cloud create — `POST /cloud-apps` as JSON.
fn post_create_cloud(name: &str, url: &str, requires_tunnel: bool) -> Request<Body> {
    post_json(
        "/cloud-apps",
        serde_json::json!({ "name": name, "url": url, "requiresTunnel": requires_tunnel }),
    )
}

fn post_json(uri: &str, body: serde_json::Value) -> Request<Body> {
    Request::post(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .expect("build")
}

fn put(uri: &str, body: serde_json::Value) -> Request<Body> {
    Request::put(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .expect("build")
}

fn delete(uri: &str) -> Request<Body> {
    Request::delete(uri).body(Body::empty()).expect("build")
}

/// A launch request — `POST /apps/{id}` with an empty body.
fn launch(uri: &str) -> Request<Body> {
    Request::post(uri).body(Body::empty()).expect("build")
}

/// Fresh-install seed: every code-defined default app present in display order.
#[tokio::test]
async fn fresh_install_lists_the_default_set() {
    let apps = spin_up();
    let res = apps
        .combined_router()
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
            "patient-browser",
            "api-view",
            "api-docs",
            "growth-chart",
            "medication-viewer",
            "precise-hbr",
        ],
    );
}

/// The self-hosted catalogue the host binds listeners for is materialized at
/// setup.
#[tokio::test]
async fn self_hosted_apps_catalogue_is_materialized() {
    let apps = spin_up();
    let (_registration, config) = apps
        .self_hosted_apps_at_start
        .iter()
        .find(|(reg, _)| reg.id == "patient-browser")
        .expect("patient-browser is self-hosted");
    assert_eq!(config.port, 8081);
}

/// A cloud app created through the admin surface shows up immediately in the
/// public list (one shared state) and round-trips through launch + delete.
#[tokio::test]
async fn cloud_app_round_trip() {
    let (apps, handle) = spin_up_with_handle();
    let router = apps.combined_router();
    let create_res = router
        .clone()
        .oneshot(post_create_cloud(
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
    assert_eq!(found["kind"], "cloud");

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

/// A seeded cloud app's content (name / url) is replaceable through `/cloud-apps`;
/// the edit persists into the public list. (`enabled` is not content — that's
/// `PUT /home-screen`.)
#[tokio::test]
async fn seeded_cloud_app_is_fully_editable() {
    let apps = spin_up();
    let router = apps.combined_router();
    let put_res = router
        .clone()
        .oneshot(put(
            "/cloud-apps/growth-chart",
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
    assert_eq!(body["kind"], "cloud");
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
    assert!(
        row.get("url").is_none(),
        "the uniform list carries no payload url"
    );

    // The replaced url is read back through the cloud detail resource.
    let detail_res = router
        .clone()
        .oneshot(get("/cloud-apps/growth-chart"))
        .await
        .expect("oneshot");
    let detail = body_json(detail_res.into_body()).await;
    assert_eq!(
        detail["url"], "https://example.com/replacement",
        "the cloud detail carries the replaced url template",
    );
}

/// A self-hosted app appears in the uniform list (kind `self-hosted`, no `url`)
/// but isn't reachable through the cloud resource — a wrong-kind id is a 404.
#[tokio::test]
async fn self_hosted_app_listed_but_not_a_cloud_resource() {
    let apps = spin_up();
    let router = apps.combined_router();
    let list_res = router.clone().oneshot(get("/apps")).await.expect("oneshot");
    let list = body_json(list_res.into_body()).await;
    let row = list
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == "patient-browser")
        .expect("patient-browser in list");
    assert_eq!(row["name"], "Patient Browser");
    assert_eq!(row["kind"], "self-hosted");
    assert!(row.get("url").is_none());

    let put_res = router
        .clone()
        .oneshot(put(
            "/cloud-apps/patient-browser",
            serde_json::json!({
                "name": "tampered",
                "url": "https://example.com/x",
                "requiresTunnel": false,
            }),
        ))
        .await
        .expect("oneshot");
    assert_eq!(put_res.status(), StatusCode::NOT_FOUND);
}

/// A loopback launch of a self-hosted app 204s to its fixed loopback origin.
#[tokio::test]
async fn self_hosted_app_launches_to_its_loopback_origin() {
    let (apps, handle) = spin_up_with_handle();
    let res = apps
        .combined_router()
        .oneshot(launch("/apps/patient-browser"))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        handle.0.lock().expect("handle mutex").clone(),
        vec!["http://127.0.0.1:8081/".to_string()],
    );
}

/// `PUT /home-screen` atomically reorders + disables any provenance and persists
/// — the positions come back a dense `0..n` permutation (no ties).
#[tokio::test]
async fn home_screen_reorders_and_disables_a_system_app() {
    let apps = spin_up();
    let router = apps.combined_router();
    // Move api-docs to the front and disable it; keep the rest in order.
    let body = serde_json::json!([
        { "id": "api-docs", "onHomescreen": false },
        { "id": "patient-browser", "onHomescreen": true },
        { "id": "api-view", "onHomescreen": true },
        { "id": "growth-chart", "onHomescreen": true },
        { "id": "medication-viewer", "onHomescreen": true },
        { "id": "precise-hbr", "onHomescreen": true },
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
            "api-docs",
            "patient-browser",
            "api-view",
            "growth-chart",
            "medication-viewer",
            "precise-hbr",
        ],
    );
    let api_docs = arr.iter().find(|v| v["id"] == "api-docs").unwrap();
    assert_eq!(api_docs["onHomescreen"], false);
}

/// A deleted seeded cloud app stays deleted (migration runner seeds once).
#[tokio::test]
async fn deleted_seeded_cloud_app_stays_deleted() {
    let apps = spin_up();
    let router = apps.combined_router();
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
        .combined_router()
        .oneshot(post_create_cloud("Bad", "javascript:alert(1)", false))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let body = body_json(res.into_body()).await;
    assert_eq!(body["error"], "InvalidUrl");
}
