use std::net::SocketAddr;

use axum::body::{to_bytes, Body};
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use gatekeeper_rust::{
    setup_gatekeeper, Gatekeeper, GatekeeperConfig, FULL_FHIR_ACCESS_SCOPE, OWNER_SCOPE,
};
use tokio::sync::watch;

const LOOPBACK_ORIGIN: &str = "http://127.0.0.1";
use chrono::{Duration, Utc};
use gatekeeper_rust::crypto_util::base64;
use gatekeeper_rust::crypto_util::client_secret::hash_client_secret;
use gatekeeper_rust::crypto_util::pkce::compute_code_challenge;
use gatekeeper_rust::crypto_util::random_token::token_storage_hash;
use gatekeeper_rust::domain::authorization_code::AuthorizationCode;
use gatekeeper_rust::domain::authorization_request::{
    AuthorizationRequest, GrantType, RequestStatus,
};
use gatekeeper_rust::domain::client::{AllowedGrantType, Client, ClientKind};
use gatekeeper_rust::domain::refresh_token::{RefreshToken, RefreshTokenFamily};
use gatekeeper_rust::GatekeeperStore;
use persistence_rust::{Connection, JsonColumn, UriColumn};
use serde_json::Value;
use tower::ServiceExt;
use url::Url;

fn spin_up() -> (Gatekeeper, String, Connection) {
    // One shared in-memory database, opened once and handed to the slice —
    // mirrors how the host wires a single DB into each slice. `db` is that
    // shared handle; `store_handle` clones it to reach the same database.
    let db = Connection::open_in_memory().expect("open shared db");
    let config = GatekeeperConfig {
        loopback_origin: LOOPBACK_ORIGIN.to_string(),
    };
    let (token_tx, token_rx) = watch::channel::<Option<String>>(None);
    let (active_device_tx, _active_device_rx) = watch::channel::<Option<String>>(None);
    let g = setup_gatekeeper(db.clone(), &config, &token_tx, active_device_tx).expect("setup");
    let host_owner_token = token_rx
        .borrow()
        .clone()
        .expect("setup_gatekeeper publishes the host owner token");
    (g, host_owner_token, db)
}

/// A second `GatekeeperStore` handle on the *same* shared connection the running
/// router uses. Tests reach through this to seed clients and to plant rows
/// (e.g. an already-expired authorization request) that the public HTTP
/// surface can't construct directly — preferred over real-time sleeps so the
/// expiry paths stay deterministic.
fn store_handle(db: &Connection) -> GatekeeperStore {
    GatekeeperStore::new(db.clone()).expect("store handle")
}

/// Register an OAuth client with an allowlisted `redirect_uri` through a
/// second store handle on the same shared connection. The redirect-back error
/// tests (RFC 6749 §4.1.2.1) need a client whose `redirect_uri` validates,
/// which the seeded first-party client (empty allowlist) cannot provide.
fn seed_client_with_redirect(
    db: &Connection,
    client_id: &str,
    redirect_uri: &str,
    scopes: &[&str],
) {
    let store = store_handle(db);
    store
        .register_client(&Client {
            client_id: client_id.to_string(),
            name: "Integration Test Client".to_string(),
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

async fn body_string(body: Body) -> String {
    let bytes = to_bytes(body, usize::MAX).await.expect("body");
    String::from_utf8(bytes.to_vec()).expect("utf8")
}

#[tokio::test]
async fn jwks_endpoint_returns_seeded_key() {
    let (g, _host_owner_token, _db) = spin_up();
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
async fn loopback_peer_gate_rejects_non_loopback_peer() {
    let (g, _host_owner_token, _db) = spin_up();
    let mut req = Request::get("/.well-known/jwks.json")
        .body(Body::empty())
        .unwrap();
    req.extensions_mut()
        .insert(ConnectInfo::<SocketAddr>("10.0.0.5:54321".parse().unwrap()));
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn bearer_gate_exempts_listed_paths_but_gates_the_rest() {
    use axum::routing::get;
    use axum::Router;
    use gatekeeper_rust::layer_router_with_gatekeeper_auth_gating;

    let (g, _host_owner_token, _db) = spin_up();
    // A trivial downstream router wrapped in the bearer gate with only the
    // discovery path exempted — exercises the real middleware wiring (full path,
    // exact match) rather than just the `is_exempt` helper.
    let inner = Router::new()
        .route("/fhir-r4/metadata", get(|| async { "ok" }))
        .route("/fhir-r4/metadata-x", get(|| async { "ok" }))
        .route("/fhir-r4/Patient", get(|| async { "ok" }));
    let gated =
        layer_router_with_gatekeeper_auth_gating(inner, g.state.clone(), &["/fhir-r4/metadata"]);

    let status = |path: &'static str| {
        let gated = gated.clone();
        async move {
            gated
                .oneshot(Request::get(path).body(Body::empty()).unwrap())
                .await
                .expect("oneshot")
                .status()
        }
    };

    // Exempt path: served without any bearer token.
    assert_eq!(status("/fhir-r4/metadata").await, StatusCode::OK);
    // A path that merely shares a prefix is NOT exempt — still gated.
    assert_eq!(
        status("/fhir-r4/metadata-x").await,
        StatusCode::UNAUTHORIZED
    );
    // A normal resource path is gated — 401 without a token.
    assert_eq!(status("/fhir-r4/Patient").await, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn access_grants_without_auth_returns_401() {
    let (g, _host_owner_token, _db) = spin_up();
    let req = loopback_request(Request::get("/access/grants"), Body::empty());
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn access_grants_with_owner_token_returns_empty_list() {
    let (g, host_owner_token, _db) = spin_up();
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
    let (g, host_owner_token, _db) = spin_up();
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
    let (g, _host_owner_token, _db) = spin_up();
    let query = "response_type=code&code_challenge_method=S256&client_id=ghost&scope=read&\
                 code_challenge=abc&redirect_uri=http%3A%2F%2Fexample.com%2Fcb&state=xyz";
    let req = loopback_request(
        Request::get(format!("/oauth/authorize?{query}")),
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
    let (g, _host_owner_token, _db) = spin_up();
    let query =
        "response_type=code&code_challenge_method=plain&client_id=wildflower-host&scope=owner&\
                 code_challenge=abc&redirect_uri=http%3A%2F%2Fexample.com%2Fcb&state=xyz";
    let req = loopback_request(
        Request::get(format!("/oauth/authorize?{query}")),
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
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let query = "response_type=token&code_challenge_method=S256&client_id=test-app&scope=read&\
                 code_challenge=abc&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz";
    let req = loopback_request(
        Request::get(format!("/oauth/authorize?{query}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::FOUND);
    let location = res.headers().get("location").expect("location header");
    assert_eq!(
        location,
        "https://app.example/cb?error=unsupported_response_type&state=xyz"
    );
}

#[tokio::test]
async fn authorize_unsupported_pkce_method_redirects_invalid_request() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let query = "response_type=code&code_challenge_method=plain&client_id=test-app&scope=read&\
                 code_challenge=abc&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz";
    let req = loopback_request(
        Request::get(format!("/oauth/authorize?{query}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::FOUND);
    let location = res.headers().get("location").expect("location header");
    assert_eq!(
        location,
        "https://app.example/cb?error=invalid_request&state=xyz"
    );
}

#[tokio::test]
async fn authorize_disallowed_scope_redirects_invalid_scope() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    // The challenge must be shape-valid (43 base64url chars) so the request
    // reaches the scope check.
    let query = "response_type=code&code_challenge_method=S256&client_id=test-app&scope=write&\
                 code_challenge=abcdefghijklmnopqrstuvwxyzABCDEF0123456789-&\
                 redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz";
    let req = loopback_request(
        Request::get(format!("/oauth/authorize?{query}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::FOUND);
    let location = res.headers().get("location").expect("location header");
    assert_eq!(
        location,
        "https://app.example/cb?error=invalid_scope&state=xyz"
    );
}

#[tokio::test]
async fn device_authorization_happy_path() {
    let (g, _host_owner_token, _db) = spin_up();
    let body = "client_id=wildflower-host&scope=wildflower%2Fadmin";
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
    let (g, _host_owner_token, _db) = spin_up();
    let body = "client_id=ghost&scope=wildflower%2Fadmin";
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
    let (g, _host_owner_token, _db) = spin_up();
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
    let (g, _host_owner_token, _db) = spin_up();
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
    let (g, _host_owner_token, _db) = spin_up();
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

/// RFC 6749 §3.2: the token endpoint requires a form-urlencoded body. The
/// `TokenRequest` extractor rejects any other `Content-Type` with a
/// cache-suppressed 400 `invalid_request` before any grant work happens.
#[tokio::test]
async fn token_exchange_rejects_non_form_content_type() {
    let (g, _host_owner_token, _db) = spin_up();
    let body = "grant_type=refresh_token&client_id=wildflower-host&refresh_token=whatever";
    let req = loopback_request(
        Request::post("/oauth/token").header("content-type", "application/json"),
        Body::from(body),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    // The rejection path must still be cache-suppressed (RFC 6749 §5.1).
    assert_eq!(
        res.headers()
            .get("cache-control")
            .map(|v| v.to_str().unwrap()),
        Some("no-store")
    );
    let body = body_json(res.into_body()).await;
    assert_eq!(body["error"], "invalid_request");
}

/// The device-code grant's `grant_type` tag is the RFC 8628 URN, which
/// arrives percent-encoded (`urn%3Aietf%3A...`) — pins that the
/// form-urlencoded parse decodes it into the right enum variant (a
/// `Malformed payload` here would mean the parse, not the lookup,
/// failed; the TS client's wire format is pinned by
/// gatekeeper-core's oauth.test.ts).
#[tokio::test]
async fn token_exchange_unknown_device_code_returns_400_invalid_grant() {
    let (g, _host_owner_token, _db) = spin_up();
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
    // The owner-token TTL is 24h; allow a couple seconds of slack on the
    // second-precision, wall-clock-derived timestamps (the reviewer asked us
    // to "allow for some uncertainty in the timing-dependent values").
    const OWNER_TOKEN_TTL_SECS: i64 = 24 * 60 * 60;

    let before = Utc::now().timestamp();
    let (_g, host_owner_token, _db) = spin_up();
    // header.payload.sig
    let parts: Vec<&str> = host_owner_token.split('.').collect();
    assert_eq!(parts.len(), 3);
    let payload_bytes = base64::url_safe_no_pad_decode(parts[1]).expect("payload");
    let payload: Value = serde_json::from_slice(&payload_bytes).expect("json");
    // iat/exp are wall-clock-derived; thread them through and check their
    // *relationship* separately (below) rather than pinning absolute instants.
    let iat = payload["iat"].as_i64().expect("iat");
    let exp = payload["exp"].as_i64().expect("exp");
    assert_eq!(
        payload,
        serde_json::json!({
            // Every token's `iss` is the stable CANONICAL_ISSUER, not the
            // loopback origin — pinning matches what HFS validates against.
            "iss": shared_structures_rust::CANONICAL_ISSUER,
            "sub": "wildflower-host",
            "aud": LOOPBACK_ORIGIN,
            // Owner token now carries BOTH the wildflower admin scope
            // (gates gatekeeper's /access/*) AND the SMART v2 full-FHIR
            // wildcard (HFS reads this to grant every FHIR op).
            "scope": format!("{OWNER_SCOPE} {FULL_FHIR_ACCESS_SCOPE}"),
            "iat": iat,
            "exp": exp,
        })
    );
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
async fn post_form(
    router: &axum::Router,
    path: &str,
    body: &'static str,
) -> axum::response::Response {
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
    let scope_vec: Vec<String> = scopes.iter().map(ToString::to_string).collect();
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
    let scope_vec: Vec<String> = scopes.iter().map(ToString::to_string).collect();
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
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
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
    assert_eq!(res.status(), StatusCode::FOUND);
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
    assert!(!token["access_token"]
        .as_str()
        .expect("access_token")
        .is_empty());
    // No `offline_access` in the grant → no standing credential.
    assert!(token.get("refresh_token").is_none());
}

/// Drive `/authorize` → Owner consent approve for one request, returning the
/// pending request id. Callers assert on the *consequences* (grant rows,
/// fast-path behaviour, refresh issuance); the flow itself is proven by
/// `auth_code_grant_happy_path_end_to_end`. Uses the shared
/// `https://app.example/cb` redirect and [`CODE_VERIFIER`]'s challenge.
async fn authorize_and_approve(
    g: &Gatekeeper,
    host_owner_token: &str,
    client_id: &str,
    scope_query: &str,
    approve_body: &'static str,
) -> String {
    let challenge = compute_code_challenge(CODE_VERIFIER);
    let query = format!(
        "response_type=code&code_challenge_method=S256&client_id={client_id}&scope={scope_query}&\
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
    assert_eq!(res.status(), StatusCode::FOUND);
    let polling = res
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .expect("location")
        .to_string();
    let request_id = polling.rsplit('/').next().expect("request id").to_string();
    let approve = loopback_request(
        Request::post(format!("/access/oauth-consents/{request_id}/approve"))
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {host_owner_token}"))
            .header("content-type", "application/json"),
        Body::from(approve_body),
    );
    let res = g.router.clone().oneshot(approve).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    request_id
}

/// Consent approval persists a `Grant` row visible on the Owner surface —
/// the standing-consent record that powers the `/authorize` fast path.
#[tokio::test]
async fn consent_approval_persists_grant() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    authorize_and_approve(
        &g,
        &host_owner_token,
        "test-app",
        "read",
        r#"{"approvedScopes":["read"]}"#,
    )
    .await;

    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get("/access/grants")
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {host_owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res.into_body()).await;
    // `id` and `grantedAt` are runtime-generated; thread them through and
    // pin everything else by comparing the whole body against one literal.
    let id = body[0]["id"].clone();
    let granted_at = body[0]["grantedAt"].clone();
    assert_eq!(
        body,
        serde_json::json!([{
            "id": id,
            "clientId": "test-app",
            "scopes": ["read"],
            "redirectUri": "https://app.example/cb",
            "grantedAt": granted_at,
            "lastUsedAt": null,
            "patient": null,
        }])
    );
}

/// Once a grant covers every requested scope, re-authorizing skips the Owner
/// UI entirely: `/authorize` 302s straight back to the client with a fresh
/// `code` (RFC 6749 §4.1 — a previously established authorization decision).
#[tokio::test]
async fn pre_approved_scopes_skip_consent_on_reauthorize() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    authorize_and_approve(
        &g,
        &host_owner_token,
        "test-app",
        "read",
        r#"{"approvedScopes":["read"]}"#,
    )
    .await;

    let challenge = compute_code_challenge(CODE_VERIFIER);
    let query = format!(
        "response_type=code&code_challenge_method=S256&client_id=test-app&scope=read&\
         code_challenge={challenge}&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=second"
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
    let location = res
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .expect("location");
    // Straight back to the client — not the polling page.
    let url = Url::parse(location).expect("location url");
    assert_eq!(
        url.as_str().split('?').next(),
        Some("https://app.example/cb")
    );
    let code = url
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned())
        .expect("code param");
    assert!(!code.is_empty());
    assert!(url
        .query_pairs()
        .any(|(k, v)| k == "state" && v == "second"));
}

/// Approvals union into the standing grant: consenting to `write` later must
/// not un-approve the previously consented `read`.
#[tokio::test]
async fn consent_approvals_union_scopes_into_grant() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["read", "write"],
    );
    authorize_and_approve(
        &g,
        &host_owner_token,
        "test-app",
        "read",
        r#"{"approvedScopes":["read"]}"#,
    )
    .await;
    // Second request asks for both, but the Owner only approves `write` —
    // the grant must still cover both afterwards.
    authorize_and_approve(
        &g,
        &host_owner_token,
        "test-app",
        "read%20write",
        r#"{"approvedScopes":["write"]}"#,
    )
    .await;

    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get("/access/grants")
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {host_owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res.into_body()).await;
    assert_eq!(body[0]["scopes"], serde_json::json!(["read", "write"]));
    assert_eq!(body.as_array().map(Vec::len), Some(1), "body = {body}");
}

/// Redeeming with a verifier that doesn't hash to the stored challenge is an
/// `invalid_grant` PKCE failure (RFC 7636 §4.6 / RFC 6749 §5.2).
#[tokio::test]
async fn auth_code_grant_wrong_verifier_rejected() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let redirect = Url::parse("https://app.example/cb").unwrap();
    plant_authorization_code(
        &store_handle(&db),
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
            "error_description": "Invalid authorization grant",
        })
    );
}

/// A code past its `expires_at` is rejected as `invalid_grant` even with the
/// correct verifier (RFC 6749 §4.1.2 short-lived codes). Forced via a
/// store-level insert of an already-expired row rather than a real-time sleep.
#[tokio::test]
async fn auth_code_grant_expired_code_rejected() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let redirect = Url::parse("https://app.example/cb").unwrap();
    plant_authorization_code(
        &store_handle(&db),
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
            "error_description": "Invalid authorization grant",
        })
    );
}

/// A code is single-use: the first `/token` redemption succeeds, the second
/// (with the same code) fails — the code is consumed atomically on redeem
/// (RFC 6749 §10.5).
#[tokio::test]
async fn auth_code_grant_replay_rejected() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let redirect = Url::parse("https://app.example/cb").unwrap();
    plant_authorization_code(
        &store_handle(&db),
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
            "error_description": "Invalid authorization grant",
        })
    );
}

/// Replaying a consumed authorization code revokes the refresh-token family it
/// minted (RFC 6749 §4.1.2 / OAuth 2.1 §4.1.2.1): the first redemption returns
/// a rotating refresh token; replaying the same code is rejected AND kills that
/// lineage, so the previously-issued refresh token can no longer be rotated.
#[tokio::test]
async fn auth_code_replay_revokes_issued_refresh_family() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["read", "offline_access"],
    );
    plant_authorization_code(
        &store_handle(&db),
        "test-app",
        &Url::parse("https://app.example/cb").unwrap(),
        &["read", "offline_access"],
        "reuse-code",
        Utc::now() + Duration::minutes(1),
    );
    let redeem = "grant_type=authorization_code&client_id=test-app&code=reuse-code&\
                  code_verifier=verifierverifierverifierverifierverifierabc&\
                  redirect_uri=https%3A%2F%2Fapp.example%2Fcb";

    // First redemption succeeds and hands back a rotating refresh token.
    let first = post_form(&g.router, "/oauth/token", redeem).await;
    assert_eq!(first.status(), StatusCode::OK);
    let refresh_token = body_json(first.into_body())
        .await
        .get("refresh_token")
        .and_then(Value::as_str)
        .expect("refresh_token issued with offline_access")
        .to_string();

    // Replaying the same code is rejected.
    let replay = post_form(&g.router, "/oauth/token", redeem).await;
    assert_eq!(replay.status(), StatusCode::BAD_REQUEST);

    // The refresh token from the first redemption is now revoked — rotating it
    // fails because the replay killed its family.
    let rotate_req = loopback_request(
        Request::post("/oauth/token").header("content-type", "application/x-www-form-urlencoded"),
        Body::from(format!(
            "grant_type=refresh_token&client_id=test-app&refresh_token={refresh_token}"
        )),
    );
    let rotate = g.router.clone().oneshot(rotate_req).await.expect("oneshot");
    assert_eq!(rotate.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(rotate.into_body()).await["error"],
        "invalid_grant"
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
    let (g, _host_owner_token, db) = spin_up();
    plant_device_request(
        &store_handle(&db),
        "wildflower-host",
        "dev-pending",
        &[OWNER_SCOPE],
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
    let (g, _host_owner_token, db) = spin_up();
    plant_device_request(
        &store_handle(&db),
        "wildflower-host",
        "dev-approved",
        &[OWNER_SCOPE],
        RequestStatus::Approved,
        Utc::now() + Duration::minutes(5),
    );
    let body = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&\
                client_id=wildflower-host&device_code=dev-approved";
    let first = post_form(&g.router, "/oauth/token", body).await;
    assert_eq!(first.status(), StatusCode::OK);
    let token = body_json(first.into_body()).await;
    assert_eq!(token["token_type"], "Bearer");
    assert_eq!(token["scope"], OWNER_SCOPE);

    let second = post_form(&g.router, "/oauth/token", body).await;
    assert_eq!(second.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(second.into_body()).await,
        serde_json::json!({ "error": "expired_token" })
    );
}

/// Device-flow consent clamps the granted scopes to the client's *current*
/// `allowed_scopes`, not just what the (possibly stale) request asked for: a
/// request that asked for `write` while it was permitted must not grant `write`
/// after the client's policy no longer allows it. Regression guard for the
/// device path, which previously intersected only with `requested_scopes` (the
/// code-flow path already clamped to `allowed_scopes`).
#[tokio::test]
async fn device_consent_clamps_granted_scopes_to_client_allowed() {
    let (g, host_owner_token, db) = spin_up();
    // The client currently permits only `read` — `write` is no longer allowed.
    seed_client_with_redirect(&db, "device-client", "https://app.example/cb", &["read"]);
    // A pending device request that still asks for the now-disallowed `write`.
    plant_device_request(
        &store_handle(&db),
        "device-client",
        "dev-clamp",
        &["read", "write"],
        RequestStatus::Pending,
        Utc::now() + Duration::minutes(5),
    );

    // The Owner approves both scopes; the handler must drop `write`.
    let approve = loopback_request(
        Request::post("/access/devices/WILD-FLWR/approve")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {host_owner_token}"))
            .header("content-type", "application/json"),
        Body::from(r#"{"approvedScopes":["read","write"]}"#),
    );
    let res = g.router.clone().oneshot(approve).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({ "status": "approved" })
    );

    // The issued token carries only the still-allowed `read`, never `write`.
    let body = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&\
                client_id=device-client&device_code=dev-clamp";
    let res = post_form(&g.router, "/oauth/token", body).await;
    assert_eq!(res.status(), StatusCode::OK);
    let token = body_json(res.into_body()).await;
    assert_eq!(token["scope"], "read");
}

/// Device-flow consent now threads an optional `patient` from the approve body
/// onto the approved request (the code flow already did). Locks in the one live
/// behavior change of the consent-dedup refactor: with the shared `ApproveBody`
/// the device endpoint *honors* a posted `patient`, so a device UI that selects
/// a patient binds it to the grant. The device UI doesn't send `patient` yet,
/// so this is the only test that exercises the wired-through path.
#[tokio::test]
async fn device_consent_threads_patient_onto_request() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "device-client", "https://app.example/cb", &["read"]);
    plant_device_request(
        &store_handle(&db),
        "device-client",
        "dev-patient",
        &["read"],
        RequestStatus::Pending,
        Utc::now() + Duration::minutes(5),
    );

    // The Owner approves and selects a patient context.
    let approve = loopback_request(
        Request::post("/access/devices/WILD-FLWR/approve")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {host_owner_token}"))
            .header("content-type", "application/json"),
        Body::from(r#"{"approvedScopes":["read"],"patient":"Patient/123"}"#),
    );
    let res = g.router.clone().oneshot(approve).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({ "status": "approved" })
    );

    // The posted patient is persisted onto the now-approved request.
    let request = store_handle(&db)
        .authorization_request_by_id("dev-patient")
        .expect("query request")
        .expect("request present");
    assert_eq!(request.status, RequestStatus::Approved);
    assert_eq!(request.patient.as_deref(), Some("Patient/123"));
}

/// A client restricted to a grant-type subset is refused a grant outside it
/// (RFC 6749 §5.2 `unauthorized_client`). Here a code-only client is rejected
/// at the refresh-token grant before any token lookup.
#[tokio::test]
async fn token_endpoint_rejects_grant_outside_client_allow_list() {
    let (g, _host_owner_token, db) = spin_up();
    store_handle(&db)
        .register_client(&Client {
            client_id: "code-only".to_string(),
            name: "Code-only client".to_string(),
            kind: ClientKind::Public,
            redirect_uris: JsonColumn(vec![Url::parse("https://app.example/cb").unwrap()]),
            allowed_scopes: JsonColumn(vec!["read".to_string(), "offline_access".to_string()]),
            allowed_grant_types: JsonColumn(vec![AllowedGrantType::AuthorizationCode]),
            secret_hash: None,
            registered_at: Utc::now(),
            disabled_at: None,
        })
        .expect("register code-only client");

    let res = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&client_id=code-only&refresh_token=whatever",
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(res.into_body()).await["error"],
        "unauthorized_client"
    );
}

/// RFC 6749 §5.1/§5.2 (inherited by RFC 8628 §3.4): the
/// `/oauth/device_authorization` response must suppress caching just like the
/// token endpoint — the token-endpoint case is already covered, this pins the
/// device endpoint.
#[tokio::test]
async fn device_authorization_sets_cache_suppression_headers() {
    let (g, _host_owner_token, _db) = spin_up();
    let res = post_form(
        &g.router,
        "/oauth/device_authorization",
        "client_id=wildflower-host&scope=wildflower%2Fadmin",
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
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

/// Granting `offline_access` issues a rotating refresh token, and the full
/// rotation contract holds: redeeming swaps generations, replaying a consumed
/// generation revokes the whole family (OAuth 2.1 rotation semantics), so the
/// rotated-to token dies with it.
#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn offline_access_issues_rotating_refresh_token() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["read", "offline_access"],
    );
    let request_id = authorize_and_approve(
        &g,
        &host_owner_token,
        "test-app",
        "read%20offline_access",
        r#"{"approvedScopes":["read","offline_access"]}"#,
    )
    .await;

    // Pull the redeemable code off the status poll, then redeem it.
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
    let redirect = status["redirect"].as_str().expect("redirect");
    let code = Url::parse(redirect)
        .expect("redirect url")
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned())
        .expect("code param");
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
    assert_eq!(token["scope"], "read offline_access");
    let first_refresh = token["refresh_token"]
        .as_str()
        .expect("refresh_token present with offline_access")
        .to_string();

    // Redeem the refresh token: fresh access token + the next generation.
    let body = format!("grant_type=refresh_token&client_id=test-app&refresh_token={first_refresh}");
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::post("/oauth/token")
                .header("content-type", "application/x-www-form-urlencoded"),
            Body::from(body.clone()),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let refreshed = body_json(res.into_body()).await;
    assert_eq!(refreshed["token_type"], "Bearer");
    assert_eq!(refreshed["scope"], "read offline_access");
    assert!(!refreshed["access_token"]
        .as_str()
        .expect("access_token")
        .is_empty());
    let second_refresh = refreshed["refresh_token"]
        .as_str()
        .expect("rotated refresh_token")
        .to_string();
    assert_ne!(second_refresh, first_refresh);

    // Replaying the consumed generation is treated as theft …
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
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_grant",
            "error_description": "Refresh token has been revoked",
        })
    );

    // … which kills the whole family: the rotated-to token is dead too. The
    // family is expired in place (not deleted), so it reports as expired.
    let body =
        format!("grant_type=refresh_token&client_id=test-app&refresh_token={second_refresh}");
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
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_grant",
            "error_description": "Refresh token has expired",
        })
    );
}

/// Plant a refresh-token family with one live token directly in the store,
/// with a caller-controlled family deadline so expiry tests don't sleep.
fn plant_refresh_token(
    store: &GatekeeperStore,
    plaintext: &str,
    client_id: &str,
    family_expires_at: chrono::DateTime<Utc>,
) {
    let now = Utc::now();
    store
        .insert_refresh_token_family(
            &RefreshTokenFamily {
                family_id: format!("family-{plaintext}"),
                client_id: client_id.to_string(),
                scopes: JsonColumn(vec!["read".to_string(), "offline_access".to_string()]),
                patient: None,
                issued_at: now,
                expires_at: family_expires_at,
                authorization_code_hash: None,
            },
            &RefreshToken {
                token_hash: token_storage_hash(plaintext),
                family_id: format!("family-{plaintext}"),
                issued_at: now,
                consumed_at: None,
            },
        )
        .expect("insert refresh token family");
}

/// A refresh token past its family's absolute deadline is `invalid_grant`.
/// The rows survive the attempt — natural deadline passage writes nothing.
#[tokio::test]
async fn expired_refresh_token_family_is_rejected() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["read", "offline_access"],
    );
    let store = store_handle(&db);
    plant_refresh_token(
        &store,
        "stale-token",
        "test-app",
        Utc::now() - Duration::days(1),
    );

    let res = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&client_id=test-app&refresh_token=stale-token",
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_grant",
            "error_description": "Refresh token has expired",
        })
    );
    let row = store
        .refresh_token_by_hash(&token_storage_hash("stale-token"))
        .expect("query")
        .expect("row kept");
    assert_eq!(row.consumed_at, None);
}

/// A refresh token presented by a different registered client is rejected
/// exactly like an unknown token (RFC 6749 §6 client binding) — and the
/// mismatch does NOT revoke the rightful owner's family.
#[tokio::test]
async fn refresh_token_is_bound_to_issuing_client() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "owner-app", "https://app.example/cb", &["read"]);
    seed_client_with_redirect(&db, "other-app", "https://other.example/cb", &["read"]);
    let store = store_handle(&db);
    plant_refresh_token(
        &store,
        "owned-token",
        "owner-app",
        Utc::now() + Duration::days(30),
    );

    let res = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&client_id=other-app&refresh_token=owned-token",
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_grant",
            "error_description": "Invalid refresh_token parameter",
        })
    );
    // The rightful owner's token is untouched — still live.
    let row = store
        .refresh_token_by_hash(&token_storage_hash("owned-token"))
        .expect("query")
        .expect("row present");
    assert_eq!(row.consumed_at, None);
}

/// Revoking a grant on the Owner surface also kills the client's refresh
/// tokens — standing consent and standing credentials die together.
#[tokio::test]
async fn revoking_grant_revokes_refresh_tokens() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["read", "offline_access"],
    );
    authorize_and_approve(
        &g,
        &host_owner_token,
        "test-app",
        "read",
        r#"{"approvedScopes":["read"]}"#,
    )
    .await;
    let store = store_handle(&db);
    plant_refresh_token(
        &store,
        "standing-token",
        "test-app",
        Utc::now() + Duration::days(30),
    );

    // Find the grant id on the Owner surface, then revoke it.
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get("/access/grants")
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {host_owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    let grants = body_json(res.into_body()).await;
    let grant_id = grants[0]["id"].as_str().expect("grant id").to_string();
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::delete(format!("/access/grants/{grant_id}"))
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {host_owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

    // Soft-revoked: the rows survive for audit, but the family's deadline is
    // pulled back and the live token is stamped consumed — and redeeming it
    // reports the family as expired.
    let (token, family) = store
        .refresh_token_with_family_by_hash(&token_storage_hash("standing-token"))
        .expect("query")
        .expect("rows kept");
    assert!(family.expires_at <= Utc::now());
    assert!(token.consumed_at.is_some());
    let res = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&client_id=test-app&refresh_token=standing-token",
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_grant",
            "error_description": "Refresh token has expired",
        })
    );
}

// ---------------------------------------------------------------------------
// Confidential-client authentication (RFC 6749 §2.3.1 client_secret_basic /
// client_secret_post)
// ---------------------------------------------------------------------------

/// Register a confidential client whose argon2id `secret_hash` matches
/// `client_secret_plaintext`, through a second store handle — mirrors
/// `seed_client_with_redirect`, which can only seed public clients.
fn seed_confidential_client(
    db: &Connection,
    client_id: &str,
    client_secret_plaintext: &str,
    scopes: &[&str],
) {
    let store = store_handle(db);
    store
        .register_client(&Client {
            client_id: client_id.to_string(),
            name: "Integration Test Confidential Client".to_string(),
            kind: ClientKind::Confidential,
            redirect_uris: JsonColumn(vec![]),
            allowed_scopes: JsonColumn(scopes.iter().map(ToString::to_string).collect()),
            allowed_grant_types: JsonColumn(AllowedGrantType::ALL.to_vec()),
            secret_hash: Some(hash_client_secret(client_secret_plaintext).expect("hash secret")),
            registered_at: Utc::now(),
            disabled_at: None,
        })
        .expect("register confidential client");
}

/// `post_form` plus an `Authorization` header; takes an owned body since the
/// Basic-auth tests build it with `format!`.
async fn post_form_with_authorization(
    router: &axum::Router,
    path: &str,
    body: String,
    authorization: &str,
) -> axum::response::Response {
    let req = loopback_request(
        Request::post(path)
            .header("content-type", "application/x-www-form-urlencoded")
            .header("authorization", authorization),
        Body::from(body),
    );
    router.clone().oneshot(req).await.expect("oneshot")
}

/// `Authorization` header value for `client_secret_basic` (RFC 6749 §2.3.1).
/// Callers that need percent-encoded halves pre-encode them and call
/// `base64` directly instead.
fn basic_authorization(client_id: &str, client_secret: &str) -> String {
    format!(
        "Basic {}",
        base64::standard_encode(format!("{client_id}:{client_secret}").as_bytes())
    )
}

const CONFIDENTIAL_CLIENT_ID: &str = "conf-app";
const CONFIDENTIAL_CLIENT_SECRET: &str = "shhh-integration-secret";

/// Spin up a gatekeeper with a seeded confidential client and a live planted
/// refresh token — the cheapest real grant to exercise client auth against.
fn spin_up_with_confidential_client() -> (Gatekeeper, Connection) {
    let (g, _host_owner_token, db) = spin_up();
    seed_confidential_client(
        &db,
        CONFIDENTIAL_CLIENT_ID,
        CONFIDENTIAL_CLIENT_SECRET,
        &["read", "offline_access"],
    );
    plant_refresh_token(
        &store_handle(&db),
        "conf-token",
        CONFIDENTIAL_CLIENT_ID,
        Utc::now() + Duration::days(30),
    );
    (g, db)
}

/// Happy path for `client_secret_basic`: credentials only in the header, the
/// grant redeems and mints a token (RFC 6749 §2.3.1).
#[tokio::test]
async fn token_exchange_with_basic_auth_redeems_refresh_token() {
    let (g, _db) = spin_up_with_confidential_client();
    let res = post_form_with_authorization(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&refresh_token=conf-token".to_string(),
        &basic_authorization(CONFIDENTIAL_CLIENT_ID, CONFIDENTIAL_CLIENT_SECRET),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res.into_body()).await;
    assert_eq!(body["token_type"], "Bearer");
    assert!(!body["access_token"]
        .as_str()
        .expect("access_token")
        .is_empty());
}

/// A failed Basic attempt answers 401 with a matching `WWW-Authenticate:
/// Basic` challenge (RFC 6749 §5.2) — and stays cache-suppressed.
#[tokio::test]
async fn token_exchange_wrong_basic_secret_returns_401_with_basic_challenge() {
    let (g, _db) = spin_up_with_confidential_client();
    let res = post_form_with_authorization(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&refresh_token=conf-token".to_string(),
        &basic_authorization(CONFIDENTIAL_CLIENT_ID, "not-the-secret"),
    )
    .await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        res.headers()
            .get("www-authenticate")
            .map(|v| v.to_str().unwrap()),
        Some(r#"Basic realm="gatekeeper""#)
    );
    assert_eq!(
        res.headers()
            .get("cache-control")
            .map(|v| v.to_str().unwrap()),
        Some("no-store")
    );
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_client",
            "error_description": "Invalid client_secret",
        })
    );
}

/// A failed `client_secret_post` attempt is still 401 but carries NO Basic
/// challenge — the client never used the Authorization header (RFC 6749 §5.2
/// only mandates the challenge for header-based attempts).
#[tokio::test]
async fn token_exchange_body_secret_failure_has_no_basic_challenge() {
    let (g, _db) = spin_up_with_confidential_client();
    let res = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&client_id=conf-app&client_secret=not-the-secret&refresh_token=conf-token",
    )
    .await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(res.headers().get("www-authenticate"), None);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_client",
            "error_description": "Invalid client_secret",
        })
    );
}

/// Presenting a secret via Basic AND the body is two authentication methods
/// in one request — rejected per RFC 6749 §2.3, even when both are correct.
#[tokio::test]
async fn token_exchange_basic_plus_body_secret_returns_400_invalid_request() {
    let (g, _db) = spin_up_with_confidential_client();
    let res = post_form_with_authorization(
        &g.router,
        "/oauth/token",
        format!(
            "grant_type=refresh_token&client_secret={CONFIDENTIAL_CLIENT_SECRET}&refresh_token=conf-token"
        ),
        &basic_authorization(CONFIDENTIAL_CLIENT_ID, CONFIDENTIAL_CLIENT_SECRET),
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_request",
            "error_description": "Multiple client authentication methods presented",
        })
    );
}

/// A body `client_id` contradicting the Basic userid is `invalid_request`.
#[tokio::test]
async fn token_exchange_basic_with_mismatched_body_client_id_returns_400_invalid_request() {
    let (g, _db) = spin_up_with_confidential_client();
    let res = post_form_with_authorization(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&client_id=other-app&refresh_token=conf-token".to_string(),
        &basic_authorization(CONFIDENTIAL_CLIENT_ID, CONFIDENTIAL_CLIENT_SECRET),
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_request",
            "error_description": "client_id does not match Basic authorization header",
        })
    );
}

/// A body `client_id` that matches the Basic userid is tolerated — common
/// client-library behavior, and not a second authentication method.
#[tokio::test]
async fn token_exchange_basic_with_matching_body_client_id_succeeds() {
    let (g, _db) = spin_up_with_confidential_client();
    let res = post_form_with_authorization(
        &g.router,
        "/oauth/token",
        format!(
            "grant_type=refresh_token&client_id={CONFIDENTIAL_CLIENT_ID}&refresh_token=conf-token"
        ),
        &basic_authorization(CONFIDENTIAL_CLIENT_ID, CONFIDENTIAL_CLIENT_SECRET),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
}

/// `client_secret_post` keeps working for confidential clients (RFC 6749
/// §2.3.1 "MAY support including the client credentials in the request-body").
#[tokio::test]
async fn token_exchange_client_secret_post_still_authenticates_confidential_client() {
    let (g, _db) = spin_up_with_confidential_client();
    let res = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&client_id=conf-app&client_secret=shhh-integration-secret&refresh_token=conf-token",
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
}

/// No Basic header and no body `client_id` — there is no client to
/// authenticate, so the request itself is malformed.
#[tokio::test]
async fn token_exchange_missing_client_id_returns_400_invalid_request() {
    let (g, _db) = spin_up_with_confidential_client();
    let res = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&refresh_token=conf-token",
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_request",
            "error_description": "Missing client_id",
        })
    );
}

/// RFC 6749 §2.3.1 form-urlencodes each Basic half before base64: a secret
/// full of reserved characters survives the encode/decode round trip.
#[tokio::test]
async fn token_exchange_basic_secret_with_reserved_characters_round_trips() {
    let (g, _host_owner_token, db) = spin_up();
    seed_confidential_client(
        &db,
        "conf-app",
        "p@ss word:100%&yes",
        &["read", "offline_access"],
    );
    plant_refresh_token(
        &store_handle(&db),
        "conf-token",
        "conf-app",
        Utc::now() + Duration::days(30),
    );
    // "p@ss word:100%&yes" form-urlencoded → "p%40ss+word%3A100%25%26yes"
    let authorization = format!(
        "Basic {}",
        base64::standard_encode("conf-app:p%40ss+word%3A100%25%26yes".as_bytes())
    );
    let res = post_form_with_authorization(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&refresh_token=conf-token".to_string(),
        &authorization,
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
}

/// RFC 8628 §3.1 inherits token-endpoint client authentication: Basic works
/// at `/oauth/device_authorization` too.
#[tokio::test]
async fn device_authorization_with_basic_auth_issues_device_code() {
    let (g, _db) = spin_up_with_confidential_client();
    let res = post_form_with_authorization(
        &g.router,
        "/oauth/device_authorization",
        "scope=read".to_string(),
        &basic_authorization(CONFIDENTIAL_CLIENT_ID, CONFIDENTIAL_CLIENT_SECRET),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res.into_body()).await;
    assert!(!body["device_code"]
        .as_str()
        .expect("device_code")
        .is_empty());
    assert!(!body["user_code"].as_str().expect("user_code").is_empty());
}

/// The device endpoint answers a failed Basic attempt exactly like the token
/// endpoint: 401 with a `WWW-Authenticate: Basic` challenge.
#[tokio::test]
async fn device_authorization_wrong_basic_secret_returns_401_with_basic_challenge() {
    let (g, _db) = spin_up_with_confidential_client();
    let res = post_form_with_authorization(
        &g.router,
        "/oauth/device_authorization",
        "scope=read".to_string(),
        &basic_authorization(CONFIDENTIAL_CLIENT_ID, "not-the-secret"),
    )
    .await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        res.headers()
            .get("www-authenticate")
            .map(|v| v.to_str().unwrap()),
        Some(r#"Basic realm="gatekeeper""#)
    );
    assert_eq!(
        body_json(res.into_body()).await,
        serde_json::json!({
            "error": "invalid_client",
            "error_description": "Invalid client_secret",
        })
    );
}
