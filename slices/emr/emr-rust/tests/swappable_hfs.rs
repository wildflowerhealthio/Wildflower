//! HFS's `base_url` — the prefix of its search Bundle links, `entry.fullUrl`s
//! and a create's `Location` — follows `FhirR4Routers::hfs`: loopback until a
//! public origin is set, then that origin, swapped in under the routers the
//! host already mounted. See `emr_rust::SwappableHfs`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use axum::body::{to_bytes, Body};
use axum::http::{HeaderMap, Request, StatusCode};
use axum::Router;
use emr_rust::{setup_fhir_r4, EmrConfig, FhirR4Routers};
use serde_json::{json, Value};
use shared_structures_rust::ServerRuntimeConfig;
use tower::ServiceExt;
use url::Url;

const LOOPBACK_BASE: &str = "http://127.0.0.1:8080/fhir-r4";
const PUBLIC_ORIGIN: &str = "https://abc.tunnel.example";
const PUBLIC_BASE: &str = "https://abc.tunnel.example/fhir-r4";

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
    let dir =
        std::env::temp_dir().join(format!("emr-rust-swappable-hfs-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp dir");

    let runtime = ServerRuntimeConfig {
        loopback_base_url: "http://127.0.0.1:8080".parse().expect("parse loopback url"),
        server_dir: dir.clone(),
    };
    let config = EmrConfig {
        log_level: "error".to_string(),
        db_file_path: dir.join("health-data.sqlite"),
        jwks_url: None,
        search_parameter_data_dir: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets"),
    };

    let revocation_store = token_revocation_rust::RevocationStore::always_allow();
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

/// The path-and-query of an absolute URL, to replay it against the in-process
/// router.
fn path_and_query(url: &str) -> String {
    let url = Url::parse(url).expect("absolute link URL");
    match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_string(),
    }
}

fn public_origin() -> Url {
    PUBLIC_ORIGIN.parse().expect("parse public origin")
}

#[tokio::test]
async fn the_base_url_is_loopback_by_default() {
    let (routers, _db) = build_routers();
    let router = &routers.augmented_fhir_r4_router;
    put_patients(router, &["a", "b"]).await;

    let (status, _, bundle) = send(router, "GET", "/fhir-r4/Patient?_count=1", None).await;

    assert_eq!(status, StatusCode::OK, "body: {bundle}");
    let next = link(&bundle, "next").unwrap_or_else(|| panic!("no next link: {bundle}"));
    assert!(
        next.starts_with(&format!("{LOOPBACK_BASE}/Patient?")),
        "next: {next}"
    );
}

#[tokio::test]
async fn a_public_origin_moves_every_emitted_url() {
    let (routers, _db) = build_routers();
    let router = &routers.augmented_fhir_r4_router;
    put_patients(router, &["a", "b"]).await;

    routers
        .hfs
        .set_base_url(Some(&public_origin()))
        .expect("set public origin");

    let (_, _, bundle) = send(router, "GET", "/fhir-r4/Patient?_count=1", None).await;
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

/// The delegation router other slices hold (OHIF) and the `$everything`
/// override both serve the swapped build, not the one they were handed at boot.
#[tokio::test]
async fn the_delegation_router_follows_the_swap() {
    let (routers, _db) = build_routers();
    put_patients(&routers.augmented_fhir_r4_router, &["a"]).await;

    routers
        .hfs
        .set_base_url(Some(&public_origin()))
        .expect("set public origin");

    let (_, _, bundle) = send(&routers.raw_hfs_router, "GET", "/Patient", None).await;
    let self_link = link(&bundle, "self").unwrap_or_else(|| panic!("no self link: {bundle}"));
    assert!(self_link.starts_with(PUBLIC_BASE), "self: {self_link}");
}

/// A cursor handed out before a swap resumes after it: cursors don't carry the
/// base, so a client mid-way through paging isn't stranded by a rebuild.
#[tokio::test]
async fn a_cursor_from_before_the_swap_resumes_after_it() {
    let (routers, _db) = build_routers();
    let router = &routers.augmented_fhir_r4_router;
    put_patients(router, &["a", "b"]).await;

    let (_, _, first) = send(router, "GET", "/fhir-r4/Patient?_count=1", None).await;
    let next = link(&first, "next").unwrap_or_else(|| panic!("no next link: {first}"));
    let first_id = first["entry"][0]["resource"]["id"].clone();

    routers
        .hfs
        .set_base_url(Some(&public_origin()))
        .expect("set public origin");

    let (status, _, second) = send(router, "GET", &path_and_query(next), None).await;
    assert_eq!(status, StatusCode::OK, "body: {second}");
    let second_id = &second["entry"][0]["resource"]["id"];
    assert!(second_id.is_string(), "second page is empty: {second}");
    assert_ne!(*second_id, first_id, "second page repeats the first");
}

#[tokio::test]
async fn clearing_the_public_origin_returns_to_loopback() {
    let (routers, _db) = build_routers();
    let router = &routers.augmented_fhir_r4_router;
    put_patients(router, &["a"]).await;

    let hfs = &routers.hfs;
    hfs.set_base_url(Some(&public_origin()))
        .expect("set public origin");
    hfs.set_base_url(None).expect("clear public origin");

    let (_, _, bundle) = send(router, "GET", "/fhir-r4/Patient", None).await;
    let self_link = link(&bundle, "self").unwrap_or_else(|| panic!("no self link: {bundle}"));
    assert!(self_link.starts_with(LOOPBACK_BASE), "self: {self_link}");
}

#[tokio::test]
async fn an_unusable_public_origin_is_refused_and_keeps_the_base() {
    let (routers, _db) = build_routers();
    let router = &routers.augmented_fhir_r4_router;
    put_patients(router, &["a"]).await;

    let hfs = &routers.hfs;
    hfs.set_base_url(Some(&public_origin()))
        .expect("set public origin");
    for refused in [
        "ftp://abc.tunnel.example",
        "https://user:pw@abc.tunnel.example",
    ] {
        let origin: Url = refused.parse().expect("parse refused origin");
        assert!(
            hfs.set_base_url(Some(&origin)).is_err(),
            "accepted {refused}"
        );
    }

    let (_, _, bundle) = send(router, "GET", "/fhir-r4/Patient", None).await;
    let self_link = link(&bundle, "self").unwrap_or_else(|| panic!("no self link: {bundle}"));
    assert!(self_link.starts_with(PUBLIC_BASE), "self: {self_link}");
}
