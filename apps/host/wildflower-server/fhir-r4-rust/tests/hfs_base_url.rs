//! HFS's `base_url` — the prefix of its search Bundle links, `entry.fullUrl`s
//! and a create's `Location` — is the configured public origin's FHIR base, on
//! both routers `setup_fhir_r4` hands back. The SMART discovery document names
//! the public origin itself as its `issuer`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use axum::body::{to_bytes, Body};
use axum::http::{HeaderMap, Request, StatusCode};
use axum::Router;
use serde_json::{json, Value};
use tower::ServiceExt;
use wildflowerhealthio_fhir_r4::{setup_fhir_r4, FhirR4Config, FhirR4Routers};
use wildflowerhealthio_shared_structures::ServerRuntimeConfig;

const PUBLIC_ORIGIN: &str = "https://abc.relay.example";
const PUBLIC_BASE: &str = "https://abc.relay.example/fhir-r4";

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

/// Build fresh FHIR routers backed by a throwaway sqlite db. HFS auth is off.
fn build_routers() -> (FhirR4Routers, TempDb) {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "fhir-r4-rust-hfs-base-url-{}-{n}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");

    let runtime = ServerRuntimeConfig {
        loopback_base_url: "http://127.0.0.1:8080".parse().expect("parse loopback url"),
        server_dir: dir.clone(),
    };
    let config = FhirR4Config {
        log_level: "error".to_string(),
        db_file_path: dir.join("health-data.sqlite"),
        jwks_url: None,
        search_parameter_data_dir: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets"),
        public_origin: PUBLIC_ORIGIN.parse().expect("parse public origin"),
    };

    let revocation_store = wildflowerhealthio_token_revocation::RevocationStore::always_allow();
    let routers = setup_fhir_r4(&runtime, &config, revocation_store).expect("setup_fhir_r4");
    (routers, TempDb { dir })
}

/// Drive the router with one in-process request, returning the status, headers
/// and parsed JSON body (`Value::Null` for an empty body).
async fn send(
    router: &Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, HeaderMap, Value) {
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
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read response body");
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).expect("parse response JSON")
    };
    (status, headers, value)
}

fn patient(id: &str) -> Value {
    json!({ "resourceType": "Patient", "id": id })
}

async fn put_patients(router: &Router, ids: &[&str]) {
    for id in ids {
        let (status, _, body) = send(
            router,
            "PUT",
            &format!("/fhir-r4/Patient/{id}"),
            Some(patient(id)),
        )
        .await;
        assert!(status.is_success(), "PUT Patient/{id}: {status} {body}");
    }
}

/// The URL of the Bundle link with `relation`, if any.
fn link<'a>(bundle: &'a Value, relation: &str) -> Option<&'a str> {
    bundle["link"]
        .as_array()?
        .iter()
        .find(|link| link["relation"] == relation)?["url"]
        .as_str()
}

#[tokio::test]
async fn every_emitted_url_is_on_the_public_origin() {
    let (routers, _db) = build_routers();
    let router = &routers.augmented_fhir_r4_router;
    put_patients(router, &["a", "b"]).await;

    let (status, _, bundle) = send(router, "GET", "/fhir-r4/Patient?_count=1", None).await;
    assert_eq!(status, StatusCode::OK, "body: {bundle}");
    for relation in ["self", "next"] {
        let url = link(&bundle, relation).unwrap_or_else(|| panic!("no {relation}: {bundle}"));
        assert!(
            url.starts_with(&format!("{PUBLIC_BASE}/Patient?")),
            "{relation}: {url}"
        );
    }
    let full_url = bundle["entry"][0]["fullUrl"]
        .as_str()
        .expect("entry fullUrl");
    assert!(
        full_url.starts_with(&format!("{PUBLIC_BASE}/Patient/")),
        "fullUrl: {full_url}"
    );

    let (status, headers, body) = send(
        router,
        "POST",
        "/fhir-r4/Patient",
        Some(json!({ "resourceType": "Patient" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
    let location = headers["location"].to_str().expect("ASCII Location");
    assert!(
        location.starts_with(&format!("{PUBLIC_BASE}/Patient/")),
        "Location: {location}"
    );
}

/// The delegation router other slices hold (OHIF) emits the same base.
#[tokio::test]
async fn the_delegation_router_is_on_the_public_origin() {
    let (routers, _db) = build_routers();
    put_patients(&routers.augmented_fhir_r4_router, &["a"]).await;

    let (_, _, bundle) = send(&routers.raw_hfs_router, "GET", "/Patient", None).await;
    let self_link = link(&bundle, "self").unwrap_or_else(|| panic!("no self link: {bundle}"));
    assert!(self_link.starts_with(PUBLIC_BASE), "self: {self_link}");
}

/// Discovery reports the server's origin as `issuer` (every token's `iss`),
/// even when served over loopback, where its endpoint URLs are loopback ones.
#[tokio::test]
async fn smart_discovery_reports_the_public_origin_as_issuer() {
    let (routers, _db) = build_routers();
    let (status, _, document) = send(
        &routers.augmented_fhir_r4_router,
        "GET",
        "/fhir-r4/.well-known/smart-configuration",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {document}");
    assert_eq!(document["issuer"], PUBLIC_ORIGIN);
    assert_eq!(
        document["token_endpoint"],
        "http://127.0.0.1:8080/oauth/token"
    );
}
