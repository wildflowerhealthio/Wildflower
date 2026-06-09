use std::net::SocketAddr;

use axum::body::{to_bytes, Body};
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use gatekeeper_rust::{setup_gatekeeper, Gatekeeper, GatekeeperConfig};

const LOOPBACK_ORIGIN: &str = "http://127.0.0.1";
use serde_json::Value;
use tempfile::TempDir;
use tower::ServiceExt;

async fn spin_up() -> (Gatekeeper, TempDir) {
    let tmp = TempDir::new().expect("tmp dir");
    let config = GatekeeperConfig {
        db_file_path: tmp.path().join("gatekeeper.sqlite"),
    };
    let g = setup_gatekeeper(&config).await.expect("setup");
    (g, tmp)
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

async fn body_string(body: Body) -> String {
    let bytes = to_bytes(body, usize::MAX).await.expect("body");
    String::from_utf8(bytes.to_vec()).expect("utf8")
}

#[tokio::test]
async fn jwks_endpoint_returns_seeded_key() {
    let (g, _tmp) = spin_up().await;
    let req = loopback_request(
        Request::get("/.well-known/jwks.json"),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res.into_body()).await;
    let keys = body["keys"].as_array().expect("keys array");
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0]["kty"], "RSA");
    assert_eq!(keys[0]["alg"], "RS256");
    assert!(keys[0]["n"].is_string());
    assert!(keys[0]["e"].is_string());
    // private fields must not be exposed.
    assert!(keys[0].get("d").is_none());
}

#[tokio::test]
async fn loopback_gate_rejects_non_loopback_peer() {
    let (g, _tmp) = spin_up().await;
    let mut req = Request::get("/.well-known/jwks.json")
        .body(Body::empty())
        .unwrap();
    req.extensions_mut().insert(ConnectInfo::<SocketAddr>(
        "10.0.0.5:54321".parse().unwrap(),
    ));
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn access_grants_without_auth_returns_401() {
    let (g, _tmp) = spin_up().await;
    let req = loopback_request(Request::get("/access/grants"), Body::empty());
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn access_grants_with_owner_token_returns_empty_list() {
    let (g, _tmp) = spin_up().await;
    let token = gatekeeper_rust::mint_host_owner_token(&g.state, LOOPBACK_ORIGIN, 60)
        .await
        .expect("mint");
    let req = loopback_request(
        Request::get("/access/grants")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {}", token)),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res.into_body()).await;
    assert_eq!(body, serde_json::json!([]));
}

#[tokio::test]
async fn get_unknown_grant_returns_404() {
    let (g, _tmp) = spin_up().await;
    let token = gatekeeper_rust::mint_host_owner_token(&g.state, LOOPBACK_ORIGIN, 60)
        .await
        .expect("mint");
    let req = loopback_request(
        Request::get("/access/grants/nope")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {}", token)),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let body = body_json(res.into_body()).await;
    assert_eq!(body["error"], "GrantNotFound");
}

#[tokio::test]
async fn authorize_unknown_client_returns_html_bad_request() {
    let (g, _tmp) = spin_up().await;
    let query = "code_challenge_method=S256&client_id=ghost&scope=read&\
                 code_challenge=abc&redirect_uri=http%3A%2F%2Fexample.com%2Fcb&state=xyz";
    let req = loopback_request(
        Request::get(format!("/oauth/authorize?{}", query)),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let body = body_string(res.into_body()).await;
    assert!(body.contains("Unknown client"), "body = {body}");
}

#[tokio::test]
async fn authorize_unsupported_pkce_method() {
    let (g, _tmp) = spin_up().await;
    let query = "code_challenge_method=plain&client_id=wildflower-host&scope=owner&\
                 code_challenge=abc&redirect_uri=http%3A%2F%2Fexample.com%2Fcb&state=xyz";
    let req = loopback_request(
        Request::get(format!("/oauth/authorize?{}", query)),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let body = body_string(res.into_body()).await;
    assert!(body.contains("Unsupported code challenge method"), "body = {body}");
}

#[tokio::test]
async fn device_authorization_happy_path() {
    let (g, _tmp) = spin_up().await;
    let body = "client_id=wildflower-host&scope=owner";
    let req = loopback_request(
        Request::post("/oauth/device_authorization")
            .header("content-type", "application/x-www-form-urlencoded"),
        Body::from(body),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res.into_body()).await;
    assert!(body["device_code"].as_str().unwrap().len() > 0);
    let user_code = body["user_code"].as_str().unwrap();
    assert!(gatekeeper_rust::crypto::user_code::is_valid_user_code(user_code));
    assert_eq!(body["interval"], 5);
}

#[tokio::test]
async fn device_authorization_unknown_client_returns_401() {
    let (g, _tmp) = spin_up().await;
    let body = "client_id=ghost&scope=owner";
    let req = loopback_request(
        Request::post("/oauth/device_authorization")
            .header("content-type", "application/x-www-form-urlencoded"),
        Body::from(body),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    let body = body_json(res.into_body()).await;
    assert_eq!(body["error"], "invalid_client");
}

#[tokio::test]
async fn token_exchange_unknown_code_returns_400() {
    let (g, _tmp) = spin_up().await;
    let body = "grant_type=authorization_code&client_id=wildflower-host&\
                code=missing&code_verifier=verifierverifierverifierverifierverifierverifierverifier&\
                redirect_uri=http%3A%2F%2Fexample.com%2Fcb";
    let req = loopback_request(
        Request::post("/oauth/token")
            .header("content-type", "application/x-www-form-urlencoded"),
        Body::from(body),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let body = body_json(res.into_body()).await;
    assert_eq!(body["error"], "invalid_request");
}

#[tokio::test]
async fn mint_host_owner_token_is_owner_scoped() {
    let (g, _tmp) = spin_up().await;
    let token = gatekeeper_rust::mint_host_owner_token(&g.state, LOOPBACK_ORIGIN, 60)
        .await
        .expect("mint");
    // header.payload.sig
    let parts: Vec<&str> = token.split('.').collect();
    assert_eq!(parts.len(), 3);
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    let payload_bytes = URL_SAFE_NO_PAD.decode(parts[1]).expect("payload");
    let payload: Value = serde_json::from_slice(&payload_bytes).expect("json");
    assert_eq!(payload["sub"], "wildflower-host");
    assert_eq!(payload["iss"], LOOPBACK_ORIGIN);
    assert_eq!(payload["scope"], "owner");
}
