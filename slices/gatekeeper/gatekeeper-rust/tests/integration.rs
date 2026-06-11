use std::net::SocketAddr;

use axum::body::{to_bytes, Body};
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use gatekeeper_rust::{setup_gatekeeper, Gatekeeper, GatekeeperConfig};
use tokio::sync::watch;

const LOOPBACK_ORIGIN: &str = "http://127.0.0.1";
use chrono::{Duration, Utc};
use gatekeeper_rust::crypto_util::pkce::compute_code_challenge;
use gatekeeper_rust::db_utils::{JsonColumn, UriColumn};
use gatekeeper_rust::domain::authorization_code::AuthorizationCode;
use gatekeeper_rust::domain::authorization_request::{
    AuthorizationRequest, GrantType, RequestStatus,
};
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
        loopback_origin: LOOPBACK_ORIGIN.to_string(),
    };
    let (token_tx, token_rx) = watch::channel::<Option<String>>(None);
    let g = setup_gatekeeper(&config, &token_tx).expect("setup");
    let host_owner_token = token_rx
        .borrow()
        .clone()
        .expect("setup_gatekeeper publishes the host owner token");
    (g, host_owner_token, tmp)
}

/// Open a second `GatekeeperStore` handle on the same SQLite file the running
/// router uses. Tests reach through this to seed clients and to plant rows
/// (e.g. an already-expired authorization request) that the public HTTP
/// surface can't construct directly — preferred over real-time sleeps so the
/// expiry paths stay deterministic.
fn store_handle(tmp: &TempDir) -> GatekeeperStore {
    GatekeeperStore::open(&tmp.path().join("gatekeeper.sqlite")).expect("open second handle")
}

/// Register an OAuth client with an allowlisted `redirect_uri` through a
/// second store handle on the same SQLite file. The redirect-back error
/// tests (RFC 6749 §4.1.2.1) need a client whose redirect_uri validates,
/// which the seeded first-party client (empty allowlist) cannot provide.
fn seed_client_with_redirect(tmp: &TempDir, client_id: &str, redirect_uri: &str, scopes: &[&str]) {
    let store = store_handle(tmp);
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
    // The kid/n/e are key-material-derived, so thread them through from the
    // actual key; everything else (kty/alg/key_ops and — crucially — the
    // *absence* of any private field like d/p/q) is pinned by comparing the
    // entire body against one literal.
    let key = &body["keys"][0];
    let kid = key["kid"].clone();
    let n = key["n"].clone();
    let e = key["e"].clone();
    assert_eq!(
        body,
        serde_json::json!({
            "keys": [{
                "kid": kid,
                "kty": "RSA",
                "alg": "RS256",
                "key_ops": ["verify"],
                "n": n,
                "e": e,
            }]
        })
    );
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
    // device_code/user_code are random, so thread them through; the rest of
    // the RFC 8628 §3.2 body (verification_uri, verification_uri_complete,
    // expires_in, interval) is pinned by the whole-value comparison.
    let device_code = body["device_code"].clone();
    let user_code = body["user_code"].as_str().expect("user_code").to_string();
    assert_eq!(
        body,
        serde_json::json!({
            "device_code": device_code,
            "user_code": user_code,
            "verification_uri": format!("{LOOPBACK_ORIGIN}/gatekeeper/devices"),
            "verification_uri_complete":
                format!("{LOOPBACK_ORIGIN}/gatekeeper/devices?user_code={user_code}"),
            "expires_in": 300,
            "interval": 5,
        })
    );
    // The user_code is also a well-formed, human-typeable pairing code — a
    // relationship the opaque whole-value comparison above can't express.
    assert!(gatekeeper_rust::crypto_util::oauth_user_code::is_valid_oauth_user_code(&user_code));
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
    let before = Utc::now().timestamp();
    let (_g, host_owner_token, _tmp) = spin_up();
    // header.payload.sig
    let parts: Vec<&str> = host_owner_token.split('.').collect();
    assert_eq!(parts.len(), 3);
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    let payload_bytes = URL_SAFE_NO_PAD.decode(parts[1]).expect("payload");
    let payload: Value = serde_json::from_slice(&payload_bytes).expect("json");
    // iat/exp are wall-clock-derived; thread them through and check their
    // *relationship* separately (below) rather than pinning absolute instants.
    let iat = payload["iat"].as_i64().expect("iat");
    let exp = payload["exp"].as_i64().expect("exp");
    assert_eq!(
        payload,
        serde_json::json!({
            "iss": LOOPBACK_ORIGIN,
            "sub": "wildflower-host",
            "aud": LOOPBACK_ORIGIN,
            "scope": "owner",
            "iat": iat,
            "exp": exp,
        })
    );
    // The owner-token TTL is 24h; allow a couple seconds of slack on the
    // second-precision, wall-clock-derived timestamps (the reviewer asked us
    // to "allow for some uncertainty in the timing-dependent values").
    const OWNER_TOKEN_TTL_SECS: i64 = 24 * 60 * 60;
    assert!(
        (exp - iat - OWNER_TOKEN_TTL_SECS).abs() <= 2,
        "exp - iat = {} should be ~{OWNER_TOKEN_TTL_SECS}",
        exp - iat
    );
    // `before` is captured ahead of `spin_up`, which generates an RSA key —
    // slow and variable under parallel test load — so this window is generous.
    // It only pins that `iat` is a *recent* wall-clock instant (not 0, not far
    // future); the exp - iat relationship above carries the precise check.
    let now = Utc::now().timestamp();
    assert!(
        (before..=now).contains(&iat),
        "iat = {iat} should fall within the test's wall-clock envelope [{before}, {now}]"
    );
}

// ---------------------------------------------------------------------------
// End-to-end grant flows
// ---------------------------------------------------------------------------

/// A `code_verifier`/`code_challenge` pair used across the auth-code tests.
/// The verifier is 43 unreserved chars (RFC 7636 §4.1 minimum) and the
/// challenge is its real S256 digest, so the `/token` PKCE check passes.
const CODE_VERIFIER: &str = "verifierverifierverifierverifierverifierabc";

/// POST a form-urlencoded body to `path` on a fresh oneshot of `router`.
async fn post_form(router: &axum::Router, path: &str, body: &'static str) -> axum::response::Response {
    let req = loopback_request(
        Request::post(path).header("content-type", "application/x-www-form-urlencoded"),
        Body::from(body),
    );
    router.clone().oneshot(req).await.expect("oneshot")
}

/// Plant an `Approved` code-flow request plus its redeemable
/// `AuthorizationCode` straight in the store, returning the `code`. `expires_at`
/// (shared by both rows) lets a caller force an already-expired code without
/// sleeping. The challenge is the real S256 digest of [`CODE_VERIFIER`].
fn plant_authorization_code(
    store: &GatekeeperStore,
    client_id: &str,
    redirect_uri: &Url,
    scopes: &[&str],
    code: &str,
    expires_at: chrono::DateTime<Utc>,
) {
    let request_id = format!("req-{code}");
    let scope_vec: Vec<String> = scopes.iter().map(|s| s.to_string()).collect();
    let challenge = compute_code_challenge(CODE_VERIFIER);
    let now = Utc::now();
    store
        .insert_authorization_request(&AuthorizationRequest {
            id: request_id.clone(),
            grant_type: GrantType::AuthorizationCode,
            client_id: client_id.to_string(),
            requested_scopes: JsonColumn(scope_vec.clone()),
            code_challenge: Some(challenge.clone()),
            code_challenge_method: Some("S256".to_string()),
            redirect_uri: Some(UriColumn(redirect_uri.clone())),
            client_state: Some("state".to_string()),
            user_code: None,
            pre_approved_scopes: JsonColumn(Vec::new()),
            requested_at: now,
            expires_at,
            last_polled_at: None,
            status: RequestStatus::Approved,
            granted_scopes: Some(JsonColumn(scope_vec.clone())),
            patient: None,
        })
        .expect("insert request");
    store
        .issue_authorization_code(&AuthorizationCode {
            code: code.to_string(),
            request_id,
            client_id: client_id.to_string(),
            redirect_uri: UriColumn(redirect_uri.clone()),
            code_challenge: challenge,
            granted_scopes: JsonColumn(scope_vec),
            patient: None,
            issued_at: now,
            expires_at,
        })
        .expect("issue code");
}

/// Plant a device-flow request directly, returning its `device_code`. `status`
/// and `expires_at` are caller-controlled so the device state-machine tests can
/// stand up Approved/expired rows the public surface can't mint on demand.
fn plant_device_request(
    store: &GatekeeperStore,
    client_id: &str,
    device_code: &str,
    scopes: &[&str],
    status: RequestStatus,
    expires_at: chrono::DateTime<Utc>,
) {
    let scope_vec: Vec<String> = scopes.iter().map(|s| s.to_string()).collect();
    let granted = matches!(status, RequestStatus::Approved).then(|| JsonColumn(scope_vec.clone()));
    store
        .insert_authorization_request(&AuthorizationRequest {
            id: device_code.to_string(),
            grant_type: GrantType::DeviceCode,
            client_id: client_id.to_string(),
            requested_scopes: JsonColumn(scope_vec),
            code_challenge: None,
            code_challenge_method: None,
            redirect_uri: None,
            client_state: None,
            user_code: Some("WILD-FLWR".to_string()),
            pre_approved_scopes: JsonColumn(Vec::new()),
            requested_at: Utc::now(),
            expires_at,
            last_polled_at: None,
            status,
            granted_scopes: granted,
            patient: None,
        })
        .expect("insert device request");
}

/// Drive the full auth-code grant: `/authorize` → owner consent approve →
/// status poll → `/token`. The core happy path; nothing else here exercises it
/// end-to-end. Asserts a signed bearer token comes back with the granted scope.
#[tokio::test]
async fn auth_code_grant_happy_path_end_to_end() {
    let (g, host_owner_token, tmp) = spin_up();
    seed_client_with_redirect(&tmp, "test-app", "https://app.example/cb", &["read"]);
    let challenge = compute_code_challenge(CODE_VERIFIER);

    // 1. /authorize parks a pending request and 302s to the owner polling page.
    let query = format!(
        "response_type=code&code_challenge_method=S256&client_id=test-app&scope=read&\
         code_challenge={challenge}&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz"
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
    assert_eq!(res.status(), StatusCode::SEE_OTHER);
    let polling = res
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .expect("location")
        .to_string();
    let request_id = polling.rsplit('/').next().expect("request id").to_string();

    // 2. Owner approves the requested scope via the consent endpoint.
    let approve = loopback_request(
        Request::post(format!("/access/oauth-consents/{request_id}/approve"))
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {host_owner_token}"))
            .header("content-type", "application/json"),
        Body::from(r#"{"approvedScopes":["read"]}"#),
    );
    let res = g.router.clone().oneshot(approve).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({ "status": "approved" })
    );

    // 3. The status poll now reports Approved and hands back the client
    //    redirect carrying the redeemable `code`.
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
    let status = body_json(res.into_body()).await;
    assert_eq!(status["status"], "approved");
    let redirect = status["redirect"].as_str().expect("redirect");
    let code = Url::parse(redirect)
        .expect("redirect url")
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned())
        .expect("code param");

    // 4. /token redeems the code with the matching PKCE verifier.
    let body = format!(
        "grant_type=authorization_code&client_id=test-app&code={code}&\
         code_verifier={CODE_VERIFIER}&redirect_uri=https%3A%2F%2Fapp.example%2Fcb"
    );
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::post("/oauth/token")
                .header("content-type", "application/x-www-form-urlencoded"),
            Body::from(body),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let token = body_json(res.into_body()).await;
    assert_eq!(token["token_type"], "Bearer");
    assert_eq!(token["scope"], "read");
    assert!(!token["access_token"].as_str().expect("access_token").is_empty());
}

/// Redeeming with a verifier that doesn't hash to the stored challenge is an
/// `invalid_grant` PKCE failure (RFC 7636 §4.6 / RFC 6749 §5.2).
#[tokio::test]
async fn auth_code_grant_wrong_verifier_rejected() {
    let (g, _host_owner_token, tmp) = spin_up();
    seed_client_with_redirect(&tmp, "test-app", "https://app.example/cb", &["read"]);
    let redirect = Url::parse("https://app.example/cb").unwrap();
    plant_authorization_code(
        &store_handle(&tmp),
        "test-app",
        &redirect,
        &["read"],
        "good-code",
        Utc::now() + Duration::minutes(1),
    );
    // A well-formed (length-valid) but wrong verifier reaches the PKCE check.
    let body = "grant_type=authorization_code&client_id=test-app&code=good-code&\
                code_verifier=wrongwrongwrongwrongwrongwrongwrongwrongwro&\
                redirect_uri=https%3A%2F%2Fapp.example%2Fcb";
    let res = post_form(&g.router, "/oauth/token", body).await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_grant",
            "error_description": "Invalid code_verifier parameter",
        })
    );
}

/// A code past its `expires_at` is rejected as `invalid_grant` even with the
/// correct verifier (RFC 6749 §4.1.2 short-lived codes). Forced via a
/// store-level insert of an already-expired row rather than a real-time sleep.
#[tokio::test]
async fn auth_code_grant_expired_code_rejected() {
    let (g, _host_owner_token, tmp) = spin_up();
    seed_client_with_redirect(&tmp, "test-app", "https://app.example/cb", &["read"]);
    let redirect = Url::parse("https://app.example/cb").unwrap();
    plant_authorization_code(
        &store_handle(&tmp),
        "test-app",
        &redirect,
        &["read"],
        "stale-code",
        Utc::now() - Duration::seconds(1),
    );
    let body = "grant_type=authorization_code&client_id=test-app&code=stale-code&\
                code_verifier=verifierverifierverifierverifierverifierabc&\
                redirect_uri=https%3A%2F%2Fapp.example%2Fcb";
    let res = post_form(&g.router, "/oauth/token", body).await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_grant",
            "error_description": "Code has expired",
        })
    );
}

/// A code is single-use: the first `/token` redemption succeeds, the second
/// (with the same code) fails — the code is consumed atomically on redeem
/// (RFC 6749 §10.5).
#[tokio::test]
async fn auth_code_grant_replay_rejected() {
    let (g, _host_owner_token, tmp) = spin_up();
    seed_client_with_redirect(&tmp, "test-app", "https://app.example/cb", &["read"]);
    let redirect = Url::parse("https://app.example/cb").unwrap();
    plant_authorization_code(
        &store_handle(&tmp),
        "test-app",
        &redirect,
        &["read"],
        "once-code",
        Utc::now() + Duration::minutes(1),
    );
    let body = "grant_type=authorization_code&client_id=test-app&code=once-code&\
                code_verifier=verifierverifierverifierverifierverifierabc&\
                redirect_uri=https%3A%2F%2Fapp.example%2Fcb";
    let first = post_form(&g.router, "/oauth/token", body).await;
    assert_eq!(first.status(), StatusCode::OK);
    let second = post_form(&g.router, "/oauth/token", body).await;
    assert_eq!(second.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(second.into_body()).await,
        serde_json::json!({
            "error": "invalid_grant",
            "error_description": "Invalid code parameter",
        })
    );
}

// ---------------------------------------------------------------------------
// Device-code grant state machine (RFC 8628 §3.4/§3.5)
// ---------------------------------------------------------------------------

/// First poll on a still-pending request returns `authorization_pending`; an
/// immediate second poll trips the slow-down rate limit
/// (`last_polled_at` is within `DEVICE_CODE_POLL_INTERVAL`).
#[tokio::test]
async fn device_grant_pending_then_slow_down() {
    let (g, _host_owner_token, tmp) = spin_up();
    plant_device_request(
        &store_handle(&tmp),
        "wildflower-host",
        "dev-pending",
        &["owner"],
        RequestStatus::Pending,
        Utc::now() + Duration::minutes(5),
    );
    let body = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&\
                client_id=wildflower-host&device_code=dev-pending";
    let first = post_form(&g.router, "/oauth/token", body).await;
    assert_eq!(first.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(first.into_body()).await,
        serde_json::json!({ "error": "authorization_pending" })
    );
    let second = post_form(&g.router, "/oauth/token", body).await;
    assert_eq!(second.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(second.into_body()).await,
        serde_json::json!({ "error": "slow_down" })
    );
}

/// An approved device request mints a token exactly once: the first exchange
/// succeeds and expires the request, so a second exchange sees `expired_token`
/// (single-use, RFC 8628 §3.4).
#[tokio::test]
async fn device_grant_single_use_then_expired_token() {
    let (g, _host_owner_token, tmp) = spin_up();
    plant_device_request(
        &store_handle(&tmp),
        "wildflower-host",
        "dev-approved",
        &["owner"],
        RequestStatus::Approved,
        Utc::now() + Duration::minutes(5),
    );
    let body = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&\
                client_id=wildflower-host&device_code=dev-approved";
    let first = post_form(&g.router, "/oauth/token", body).await;
    assert_eq!(first.status(), StatusCode::OK);
    let token = body_json(first.into_body()).await;
    assert_eq!(token["token_type"], "Bearer");
    assert_eq!(token["scope"], "owner");

    let second = post_form(&g.router, "/oauth/token", body).await;
    assert_eq!(second.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(second.into_body()).await,
        serde_json::json!({ "error": "expired_token" })
    );
}

/// RFC 6749 §5.1/§5.2 (inherited by RFC 8628 §3.4): the
/// `/oauth/device_authorization` response must suppress caching just like the
/// token endpoint — the token-endpoint case is already covered, this pins the
/// device endpoint.
#[tokio::test]
async fn device_authorization_sets_cache_suppression_headers() {
    let (g, _host_owner_token, _tmp) = spin_up();
    let res = post_form(
        &g.router,
        "/oauth/device_authorization",
        "client_id=wildflower-host&scope=owner",
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        res.headers().get("cache-control").map(|v| v.to_str().unwrap()),
        Some("no-store")
    );
    assert_eq!(
        res.headers().get("pragma").map(|v| v.to_str().unwrap()),
        Some("no-cache")
    );
}
