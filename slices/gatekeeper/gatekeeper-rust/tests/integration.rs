use std::net::SocketAddr;

use axum::body::{to_bytes, Body};
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use gatekeeper_rust::{setup_gatekeeper, Gatekeeper, GatekeeperConfig};
use tokio::sync::watch;

const LOOPBACK_ORIGIN: &str = "http://127.0.0.1";
use chrono::Utc;
use gatekeeper_rust::db_utils::JsonColumn;
use gatekeeper_rust::domain::client::{Client, ClientKind};
use gatekeeper_rust::GatekeeperStore;
use serde_json::Value;
use tempfile::TempDir;
use tower::ServiceExt;
use url::Url;

fn spin_up() -> (Gatekeeper, String, TempDir) {
    let tmp = TempDir::new().expect("tmp dir");
    let config = GatekeeperConfig {
        db_file_path: tmp.path().join("gatekeeper.sqlite"),
    };
    let (token_tx, token_rx) = watch::channel::<Option<String>>(None);
    let g = setup_gatekeeper(&config, LOOPBACK_ORIGIN, &token_tx).expect("setup");
    let host_owner_token = token_rx
        .borrow()
        .clone()
        .expect("setup_gatekeeper publishes the host owner token");
    (g, host_owner_token, tmp)
}

/// Register an OAuth client with an allowlisted `redirect_uri` through a
/// second store handle on the same SQLite file. The redirect-back error
/// tests (RFC 6749 §4.1.2.1) need a client whose redirect_uri validates,
/// which the seeded first-party client (empty allowlist) cannot provide.
fn seed_client_with_redirect(tmp: &TempDir, client_id: &str, redirect_uri: &str, scopes: &[&str]) {
    let store =
        GatekeeperStore::open(&tmp.path().join("gatekeeper.sqlite")).expect("open second handle");
    store
        .register_client(&Client {
            client_id: client_id.to_string(),
            name: "Integration Test Client".to_string(),
            kind: ClientKind::Public,
            redirect_uris: JsonColumn(vec![Url::parse(redirect_uri).expect("redirect url")]),
            allowed_scopes: JsonColumn(scopes.iter().map(|s| s.to_string()).collect()),
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

async fn body_string(body: Body) -> String {
    let bytes = to_bytes(body, usize::MAX).await.expect("body");
    String::from_utf8(bytes.to_vec()).expect("utf8")
}

#[tokio::test]
async fn jwks_endpoint_returns_seeded_key() {
    let (g, _host_owner_token, _tmp) = spin_up();
    let req = loopback_request(Request::get("/.well-known/jwks.json"), Body::empty());
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
    let (g, _host_owner_token, _tmp) = spin_up();
    let mut req = Request::get("/.well-known/jwks.json")
        .body(Body::empty())
        .unwrap();
    req.extensions_mut()
        .insert(ConnectInfo::<SocketAddr>("10.0.0.5:54321".parse().unwrap()));
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn access_grants_without_auth_returns_401() {
    let (g, _host_owner_token, _tmp) = spin_up();
    let req = loopback_request(Request::get("/access/grants"), Body::empty());
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn access_grants_with_owner_token_returns_empty_list() {
    let (g, host_owner_token, _tmp) = spin_up();
    let req = loopback_request(
        Request::get("/access/grants")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {host_owner_token}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res.into_body()).await;
    assert_eq!(body, serde_json::json!([]));
}

#[tokio::test]
async fn get_unknown_grant_returns_404() {
    let (g, host_owner_token, _tmp) = spin_up();
    let req = loopback_request(
        Request::get("/access/grants/nope")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {host_owner_token}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let body = body_json(res.into_body()).await;
    assert_eq!(body["error"], "GrantNotFound");
}

#[tokio::test]
async fn authorize_unknown_client_returns_html_bad_request() {
    let (g, _host_owner_token, _tmp) = spin_up();
    let query = "response_type=code&code_challenge_method=S256&client_id=ghost&scope=read&\
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
async fn authorize_validates_redirect_uri_before_pkce_method() {
    // RFC 6749 §4.1.2.1: client_id/redirect_uri must be validated *before*
    // any redirectable error (scope/PKCE-method), since those failures get
    // 302'd back to the validated redirect_uri. The seeded `wildflower-host`
    // client has an empty redirect_uri allowlist, so even with an unsupported
    // `code_challenge_method=plain` the request fails at redirect-uri
    // validation and renders the local "Redirect URI not allowed" page rather
    // than redirecting. (The redirect-path tests below seed a client with an
    // allowlisted redirect_uri via `seed_client_with_redirect`.)
    let (g, _host_owner_token, _tmp) = spin_up();
    let query =
        "response_type=code&code_challenge_method=plain&client_id=wildflower-host&scope=owner&\
                 code_challenge=abc&redirect_uri=http%3A%2F%2Fexample.com%2Fcb&state=xyz";
    let req = loopback_request(
        Request::get(format!("/oauth/authorize?{}", query)),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let body = body_string(res.into_body()).await;
    assert!(body.contains("Redirect URI not allowed"), "body = {body}");
}

#[tokio::test]
async fn authorize_unsupported_response_type_redirects_back() {
    // `unsupported_response_type` is a *redirectable* error (RFC 6749
    // §4.1.2.1): once client_id + redirect_uri validate, the failure goes
    // back to the client as `error` + `state` query params, not a local page.
    let (g, _host_owner_token, tmp) = spin_up();
    seed_client_with_redirect(&tmp, "test-app", "https://app.example/cb", &["read"]);
    let query = "response_type=token&code_challenge_method=S256&client_id=test-app&scope=read&\
                 code_challenge=abc&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz";
    let req = loopback_request(
        Request::get(format!("/oauth/authorize?{}", query)),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::SEE_OTHER);
    let location = res.headers().get("location").expect("location header");
    assert_eq!(
        location,
        "https://app.example/cb?error=unsupported_response_type&state=xyz"
    );
}

#[tokio::test]
async fn authorize_unsupported_pkce_method_redirects_invalid_request() {
    let (g, _host_owner_token, tmp) = spin_up();
    seed_client_with_redirect(&tmp, "test-app", "https://app.example/cb", &["read"]);
    let query = "response_type=code&code_challenge_method=plain&client_id=test-app&scope=read&\
                 code_challenge=abc&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz";
    let req = loopback_request(
        Request::get(format!("/oauth/authorize?{}", query)),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::SEE_OTHER);
    let location = res.headers().get("location").expect("location header");
    assert_eq!(
        location,
        "https://app.example/cb?error=invalid_request&state=xyz"
    );
}

#[tokio::test]
async fn authorize_disallowed_scope_redirects_invalid_scope() {
    let (g, _host_owner_token, tmp) = spin_up();
    seed_client_with_redirect(&tmp, "test-app", "https://app.example/cb", &["read"]);
    // The challenge must be shape-valid (43 base64url chars) so the request
    // reaches the scope check.
    let query = "response_type=code&code_challenge_method=S256&client_id=test-app&scope=write&\
                 code_challenge=abcdefghijklmnopqrstuvwxyzABCDEF0123456789-&\
                 redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz";
    let req = loopback_request(
        Request::get(format!("/oauth/authorize?{}", query)),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::SEE_OTHER);
    let location = res.headers().get("location").expect("location header");
    assert_eq!(
        location,
        "https://app.example/cb?error=invalid_scope&state=xyz"
    );
}

#[tokio::test]
async fn device_authorization_happy_path() {
    let (g, _host_owner_token, _tmp) = spin_up();
    let body = "client_id=wildflower-host&scope=owner";
    let req = loopback_request(
        Request::post("/oauth/device_authorization")
            .header("content-type", "application/x-www-form-urlencoded"),
        Body::from(body),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res.into_body()).await;
    assert!(!body["device_code"].as_str().unwrap().is_empty());
    let user_code = body["user_code"].as_str().unwrap();
    assert!(gatekeeper_rust::crypto_util::oauth_user_code::is_valid_oauth_user_code(user_code));
    assert_eq!(body["interval"], 5);
}

#[tokio::test]
async fn device_authorization_unknown_client_returns_401() {
    let (g, _host_owner_token, _tmp) = spin_up();
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
async fn token_exchange_unknown_code_returns_400_invalid_grant() {
    let (g, _host_owner_token, _tmp) = spin_up();
    let body = "grant_type=authorization_code&client_id=wildflower-host&\
                code=missing&code_verifier=verifierverifierverifierverifierverifierverifierverifier&\
                redirect_uri=http%3A%2F%2Fexample.com%2Fcb";
    let req = loopback_request(
        Request::post("/oauth/token").header("content-type", "application/x-www-form-urlencoded"),
        Body::from(body),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    // RFC 6749 §5.2: an unknown/unredeemable code is an `invalid_grant`, not a
    // malformed request.
    let body = body_json(res.into_body()).await;
    assert_eq!(body["error"], "invalid_grant");
}

/// RFC 7636 §4.1 caps the `code_verifier` at 43–128 chars. A too-short
/// verifier is rejected as `invalid_grant` before the code is even looked up.
#[tokio::test]
async fn token_exchange_short_code_verifier_returns_400_invalid_grant() {
    let (g, _host_owner_token, _tmp) = spin_up();
    let body = "grant_type=authorization_code&client_id=wildflower-host&\
                code=missing&code_verifier=tooshort&\
                redirect_uri=http%3A%2F%2Fexample.com%2Fcb";
    let req = loopback_request(
        Request::post("/oauth/token").header("content-type", "application/x-www-form-urlencoded"),
        Body::from(body),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let body = body_json(res.into_body()).await;
    assert_eq!(body["error"], "invalid_grant");
    assert_eq!(body["error_description"], "Invalid code_verifier parameter");
}

/// RFC 6749 §5.1/§5.2 require `Cache-Control: no-store` and `Pragma: no-cache`
/// on every `/oauth/token` response, including errors.
#[tokio::test]
async fn token_exchange_error_sets_cache_suppression_headers() {
    let (g, _host_owner_token, _tmp) = spin_up();
    let body = "grant_type=authorization_code&client_id=wildflower-host&\
                code=missing&code_verifier=verifierverifierverifierverifierverifierverifierverifier&\
                redirect_uri=http%3A%2F%2Fexample.com%2Fcb";
    let req = loopback_request(
        Request::post("/oauth/token").header("content-type", "application/x-www-form-urlencoded"),
        Body::from(body),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(
        res.headers()
            .get("cache-control")
            .map(|v| v.to_str().unwrap()),
        Some("no-store")
    );
    assert_eq!(
        res.headers().get("pragma").map(|v| v.to_str().unwrap()),
        Some("no-cache")
    );
}

/// The device-code grant's `grant_type` tag is the RFC 8628 URN, which
/// arrives percent-encoded (`urn%3Aietf%3A...`) — pins that the
/// form-urlencoded parse decodes it into the right enum variant (a
/// `Malformed payload` here would mean the parse, not the lookup,
/// failed; the TS client's wire format is pinned by
/// gatekeeper-core's oauth.test.ts).
#[tokio::test]
async fn token_exchange_unknown_device_code_returns_400_invalid_grant() {
    let (g, _host_owner_token, _tmp) = spin_up();
    let body = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&\
                client_id=wildflower-host&device_code=missing";
    let req = loopback_request(
        Request::post("/oauth/token").header("content-type", "application/x-www-form-urlencoded"),
        Body::from(body),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let body = body_json(res.into_body()).await;
    assert_eq!(body["error"], "invalid_grant");
    assert_eq!(body["error_description"], "Unknown device_code");
}

#[tokio::test]
async fn host_owner_token_is_owner_scoped() {
    let (_g, host_owner_token, _tmp) = spin_up();
    // header.payload.sig
    let parts: Vec<&str> = host_owner_token.split('.').collect();
    assert_eq!(parts.len(), 3);
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    let payload_bytes = URL_SAFE_NO_PAD.decode(parts[1]).expect("payload");
    let payload: Value = serde_json::from_slice(&payload_bytes).expect("json");
    assert_eq!(payload["sub"], "wildflower-host");
    assert_eq!(payload["iss"], LOOPBACK_ORIGIN);
    assert_eq!(payload["scope"], "owner");
}
