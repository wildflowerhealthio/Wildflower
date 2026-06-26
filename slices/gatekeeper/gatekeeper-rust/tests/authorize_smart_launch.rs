//! SMART App Launch acceptance at `/oauth/authorize`.
//!
//! Kept as a focused, self-contained integration test (its own minimal
//! harness) rather than folded into `integration.rs`: it only needs to drive
//! one authorize request and confirm the optional `launch`/`aud` SMART params
//! are accepted and don't divert validation.

use std::net::SocketAddr;

use axum::body::{to_bytes, Body};
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use chrono::Utc;
use gatekeeper_rust::crypto_util::pkce::compute_code_challenge;
use gatekeeper_rust::domain::client::{AllowedGrantType, Client, ClientKind};
use gatekeeper_rust::{setup_gatekeeper, Gatekeeper, GatekeeperConfig, GatekeeperStore};
use persistence_rust::{Connection, JsonColumn};
use serde_json::Value;
use tokio::sync::watch;
use tower::ServiceExt;
use url::Url;

const LOOPBACK_ORIGIN: &str = "http://127.0.0.1";
// Any 43+ char PKCE verifier — the code is never redeemed here, so only the
// S256 challenge's shape matters.
const CODE_VERIFIER: &str = "smart-launch-test-verifier-smart-launch-test-verifier";

fn spin_up() -> (Gatekeeper, Connection) {
    let db = Connection::open_in_memory().expect("open shared db");
    let config = GatekeeperConfig {
        loopback_origin: LOOPBACK_ORIGIN.to_string(),
    };
    let (token_tx, _token_rx) = watch::channel::<Option<String>>(None);
    let (active_device_tx, _active_device_rx) = watch::channel::<Option<String>>(None);
    let g = setup_gatekeeper(db.clone(), &config, &token_tx, active_device_tx).expect("setup");
    (g, db)
}

fn seed_client_with_redirect(db: &Connection, client_id: &str, redirect_uri: &str, scopes: &[&str]) {
    let store = GatekeeperStore::new(db.clone()).expect("store handle");
    store
        .register_client(&Client {
            client_id: client_id.to_string(),
            name: "SMART Launch Test Client".to_string(),
            kind: ClientKind::Public,
            redirect_uris: JsonColumn(vec![Url::parse(redirect_uri).expect("redirect url")]),
            allowed_scopes: JsonColumn(scopes.iter().map(ToString::to_string).collect()),
            allowed_grant_types: JsonColumn(AllowedGrantType::ALL.to_vec()),
            secret_hash: None,
            registered_at: Utc::now(),
            disabled_at: None,
        })
        .expect("register client");
}

fn loopback_request(builder: http::request::Builder, body: Body) -> Request<Body> {
    let mut req = builder.body(body).expect("build request");
    req.extensions_mut().insert(ConnectInfo::<SocketAddr>(
        "127.0.0.1:54321".parse().unwrap(),
    ));
    req
}

async fn body_json(body: Body) -> Value {
    let bytes = to_bytes(body, usize::MAX).await.expect("body");
    serde_json::from_slice(&bytes).expect("json")
}

#[tokio::test]
async fn authorize_accepts_smart_launch_and_aud_params() {
    // SMART App Launch forwards `launch` (the EHR-minted nonce) and `aud`
    // (the FHIR base URL the app expects) alongside the standard authorize
    // params. They're optional (`#[serde(default)]`) and not validated today,
    // so a request carrying them must validate exactly like one without them:
    // park a pending request and 302 to the owner polling page — never an
    // `error=` redirect back to the client.
    let (g, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let challenge = compute_code_challenge(CODE_VERIFIER);

    let query = format!(
        "response_type=code&code_challenge_method=S256&client_id=test-app&scope=read&\
         code_challenge={challenge}&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz&\
         launch=ehr-launch-nonce-123&aud=https%3A%2F%2Fapp.example%2Ffhir-r4"
    );
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get(format!("/oauth/authorize?{query}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::FOUND);
    let polling = res
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .expect("location")
        .to_string();
    assert!(
        !polling.contains("error="),
        "launch/aud must not trigger an error redirect, got {polling}"
    );

    // The pending request was actually parked: polling it reports `pending`
    // (the owner hasn't approved yet), proving the SMART params didn't divert
    // or reject the flow.
    let request_id = polling.rsplit('/').next().expect("request id").to_string();
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get(format!("/oauth/authorize/{request_id}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res.into_body()).await["status"], "pending");
}
