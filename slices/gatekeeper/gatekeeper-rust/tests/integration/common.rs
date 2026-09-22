pub use std::net::SocketAddr;

pub use axum::body::{to_bytes, Body};
pub use axum::extract::ConnectInfo;
pub use axum::http::{Request, StatusCode};
pub use gatekeeper_rust::{
    setup_gatekeeper, Gatekeeper, GatekeeperConfig, WILDFLOWER_LOCAL_GRANTED_SCOPES,
};
pub use tokio::sync::watch;

pub const LOOPBACK_ORIGIN: &str = "http://127.0.0.1";
pub use chrono::{Duration, Utc};
pub use gatekeeper_rust::crypto_util::base64;
pub use gatekeeper_rust::crypto_util::client_secret::hash_client_secret;
pub use gatekeeper_rust::crypto_util::pkce::compute_code_challenge;
pub use gatekeeper_rust::crypto_util::random_token::token_storage_hash;
pub use gatekeeper_rust::domain::authorization_code::AuthorizationCode;
pub use gatekeeper_rust::domain::authorization_request::{
    AuthorizationRequest, GrantType, RequestStatus,
};
pub use gatekeeper_rust::domain::client::{AllowedGrantType, Client, ClientKind};
pub use gatekeeper_rust::domain::refresh_token::{RefreshToken, RefreshTokenFamily};
pub use gatekeeper_rust::domain::token::{mint_access_token, NewJwtArgs};
pub use gatekeeper_rust::{GatekeeperStore, PendingConsentHead, SqliteGatekeeperStore};
pub use persistence_rust::{Connection, DieselPool};
pub use serde_json::Value;
pub use tower::ServiceExt;
pub use url::Url;

/// The two database handles the running router uses, kept so tests can open
/// second store handles onto the SAME databases: the diesel pool behind the
/// `SqliteGatekeeperStore` and the rusqlite connection behind the shared
/// `RevocationStore` (which stays rusqlite-backed — it is a separate crate).
pub struct TestDb {
    pool: DieselPool,
    revocation_conn: Connection,
    /// Live receiver on the pending-consent head the slice publishes — the same
    /// channel the Tauri host forwards to the webview popup. Held (not dropped)
    /// so tests can assert *what the popup would show* after a request lands,
    /// which is the only observable difference between "parked a request" and
    /// "parked a request and asked the Owner about it".
    pending_consent_rx: watch::Receiver<Option<PendingConsentHead>>,
}

pub fn spin_up() -> (Gatekeeper, String, TestDb) {
    // One shared in-memory diesel pool, built once and handed to the slice —
    // mirrors how the host wires the app-wide `persistence_rust::open_pool`
    // pool into each diesel-backed slice. `db.pool` is that shared handle;
    // `store_handle` clones it to reach the same database.
    let pool = persistence_rust::open_in_memory_pool().expect("open in-memory pool");
    let config = GatekeeperConfig {
        loopback_base_url: Url::parse(LOOPBACK_ORIGIN).expect("LOOPBACK_ORIGIN is a valid URL"),
        granted_scopes: gatekeeper_rust::default_local_granted_scopes(),
        first_party_client_id: gatekeeper_rust::default_first_party_client_id(),
    };
    let (token_tx, token_rx) = watch::channel::<Option<String>>(None);
    let (pending_consent_tx, pending_consent_rx) =
        watch::channel::<Option<PendingConsentHead>>(None);
    // The shared revocation store lives on the rusqlite connection the host
    // wires into both gatekeeper and the FHIR server (#269). A second handle on
    // the same connection (see `revocation_store_handle`) lets tests
    // plant/observe rows.
    let revocation_conn = Connection::open_in_memory().expect("open revocation db");
    let revocation_store = token_revocation_rust::RevocationStore::new(revocation_conn.clone())
        .expect("revocation store");
    let g = setup_gatekeeper(
        pool.clone(),
        revocation_store,
        &config,
        &token_tx,
        pending_consent_tx,
        std::sync::Arc::new(gatekeeper_rust::NoSelfHostedRedirects),
        std::sync::Arc::new(gatekeeper_rust::NoLoopbackConsentPrompt),
    )
    .expect("setup");
    let host_owner_token = token_rx
        .borrow()
        .clone()
        .expect("setup_gatekeeper publishes the host owner token");
    (
        g,
        host_owner_token,
        TestDb {
            pool,
            revocation_conn,
            pending_consent_rx,
        },
    )
}

/// The head the host popup would currently be showing — the latest value on the
/// slice's pending-consent watch channel.
pub fn pending_consent_head(db: &TestDb) -> Option<PendingConsentHead> {
    db.pending_consent_rx.borrow().clone()
}

/// A second `SqliteGatekeeperStore` handle on the *same* shared pool the running
/// router uses. Tests reach through this to seed clients and to plant rows
/// (e.g. an already-expired authorization request) that the public HTTP
/// surface can't construct directly — preferred over real-time sleeps so the
/// expiry paths stay deterministic.
pub fn store_handle(db: &TestDb) -> SqliteGatekeeperStore {
    SqliteGatekeeperStore::new(db.pool.clone()).expect("store handle")
}

/// Register an OAuth client with an allowlisted `redirect_uri` through a
/// second store handle on the same shared connection. The redirect-back error
/// tests (RFC 6749 §4.1.2.1) need a client whose `redirect_uri` validates,
/// which the seeded first-party client (empty allowlist) cannot provide.
pub fn seed_client_with_redirect(
    db: &TestDb,
    client_id: &str,
    redirect_uri: &str,
    scopes: &[&str],
) {
    let store = store_handle(db);
    store
        .upsert_client(&Client {
            client_id: client_id.to_string(),
            name: "Integration Test Client".to_string(),
            kind: ClientKind::Public,
            redirect_uris: vec![Url::parse(redirect_uri).expect("redirect url").into()],
            allowed_scopes: scopes.iter().map(ToString::to_string).collect(),
            allowed_grant_types: AllowedGrantType::ALL.to_vec(),
            secret_hash: None,
            registered_at: Utc::now(),
            disabled_at: None,
        })
        .expect("register client");
}

/// Mint a **non-owner** access token carrying exactly `scopes`, signed by the
/// seeded active key. `iss` is the canonical issuer (as every mint is) and `aud`
/// is the loopback served origin (NOT the canonical audience, which is reserved
/// for the `wf_owner`-marked host token) — so it passes `require_valid_session`'s
/// authN but is authorized only up to `scopes`. Lets the scope-gating tests drive
/// the `403` path a real client token would hit, without walking the OAuth flow.
pub fn mint_scoped_token(db: &TestDb, scopes: &[&str]) -> String {
    let key = store_handle(db)
        .active_signing_key()
        .expect("signing-key query")
        .expect("a seeded active signing key");
    let scope: Vec<String> = scopes.iter().map(|s| (*s).to_owned()).collect();
    mint_access_token(
        &key,
        &NewJwtArgs {
            client_id: "scoped-app",
            scope: &scope,
            ttl: Duration::seconds(300),
            origin: shared_structures_rust::CANONICAL_ISSUER,
            audience: Some(LOOPBACK_ORIGIN),
            patient: None,
            is_host_owner: false,
        },
    )
    .expect("mint scoped token")
}

pub fn loopback_request(builder: http::request::Builder, body: Body) -> Request<Body> {
    let mut req = builder.body(body).expect("build request");
    req.extensions_mut().insert(ConnectInfo::<SocketAddr>(
        "127.0.0.1:54321".parse().unwrap(),
    ));
    req
}

pub async fn body_json(body: Body) -> Value {
    let bytes = to_bytes(body, usize::MAX).await.expect("body");
    serde_json::from_slice(&bytes).expect("json")
}

pub async fn body_string(body: Body) -> String {
    let bytes = to_bytes(body, usize::MAX).await.expect("body");
    String::from_utf8(bytes.to_vec()).expect("utf8")
}

// ---------------------------------------------------------------------------
// End-to-end grant flows
// ---------------------------------------------------------------------------

/// A `code_verifier`/`code_challenge` pair used across the auth-code tests.
/// The verifier is 43 unreserved chars (RFC 7636 §4.1 minimum) and the
/// challenge is its real S256 digest, so the `/token` PKCE check passes.
pub const CODE_VERIFIER: &str = "verifierverifierverifierverifierverifierabc";

/// POST a form-urlencoded body to `path` on a fresh oneshot of `router`.
pub async fn post_form(
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
pub fn plant_authorization_code(
    store: &SqliteGatekeeperStore,
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
            requested_scopes: scope_vec.clone(),
            code_challenge: Some(challenge.clone()),
            code_challenge_method: Some("S256".to_string()),
            redirect_uri: Some(redirect_uri.clone()),
            client_state: Some("state".to_string()),
            user_code: None,
            pre_approved_scopes: Vec::new(),
            requested_at: now,
            expires_at,
            last_polled_at: None,
            status: RequestStatus::Approved,
            granted_scopes: Some(scope_vec.clone()),
            patient: None,
            device_name: None,
        })
        .expect("insert request");
    store
        .issue_authorization_code(&AuthorizationCode {
            code: code.to_string(),
            request_id,
            client_id: client_id.to_string(),
            redirect_uri: redirect_uri.clone(),
            code_challenge: challenge,
            granted_scopes: scope_vec,
            patient: None,
            issued_at: now,
            expires_at,
        })
        .expect("issue code");
}

/// Plant a device-flow request directly, returning its `device_code`. `status`
/// and `expires_at` are caller-controlled so the device state-machine tests can
/// stand up Approved/expired rows the public surface can't mint on demand.
pub fn plant_device_request(
    store: &SqliteGatekeeperStore,
    client_id: &str,
    device_code: &str,
    scopes: &[&str],
    status: RequestStatus,
    expires_at: chrono::DateTime<Utc>,
) {
    let scope_vec: Vec<String> = scopes.iter().map(ToString::to_string).collect();
    let granted = matches!(status, RequestStatus::Approved).then(|| scope_vec.clone());
    store
        .insert_authorization_request(&AuthorizationRequest {
            id: device_code.to_string(),
            grant_type: GrantType::DeviceCode,
            client_id: client_id.to_string(),
            requested_scopes: scope_vec,
            code_challenge: None,
            code_challenge_method: None,
            redirect_uri: None,
            client_state: None,
            user_code: Some("WILD-FLWR".to_string()),
            pre_approved_scopes: Vec::new(),
            requested_at: Utc::now(),
            expires_at,
            last_polled_at: None,
            status,
            granted_scopes: granted,
            patient: None,
            device_name: None,
        })
        .expect("insert device request");
}

/// Decode a JWT's payload (the middle base64url-no-pad segment) to JSON. The
/// signature isn't verified — fine for asserting claim *shape* in a test.
pub fn decode_jwt_payload(token: &str) -> serde_json::Value {
    let payload_b64 = token.split('.').nth(1).expect("jwt payload segment");
    let bytes = base64::url_safe_no_pad_decode(payload_b64).expect("base64url payload");
    serde_json::from_slice(&bytes).expect("payload json")
}

/// The `/oauth/authorize` query for the shared `https://app.example/cb` redirect
/// and [`CODE_VERIFIER`]'s real S256 challenge, so a request reaches the
/// registration checks rather than failing PKCE validation first.
pub fn authorize_query(client_id: &str, scope_query: &str) -> String {
    let challenge = compute_code_challenge(CODE_VERIFIER);
    format!(
        "response_type=code&code_challenge_method=S256&client_id={client_id}&scope={scope_query}&\
         code_challenge={challenge}&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz"
    )
}

/// `GET /oauth/authorize?{query}` on a fresh oneshot of `router`.
pub async fn get_authorize(router: &axum::Router, query: &str) -> axum::response::Response {
    router
        .clone()
        .oneshot(loopback_request(
            Request::get(format!("/oauth/authorize?{query}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot")
}

/// The `Location` of a 302, as a string.
pub fn location_of(res: &axum::response::Response) -> String {
    res.headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .expect("location header")
        .to_string()
}

/// Assert `res` is a 302 to the Owner UI's polling page and return the pending
/// request id it names — the shape every parked `/authorize` request takes.
pub fn parked_request_id(res: &axum::response::Response) -> String {
    assert_eq!(res.status(), StatusCode::FOUND);
    let location = location_of(res);
    assert!(
        location.contains("/gatekeeper/") && !location.contains("error="),
        "expected a polling-page redirect, got {location}"
    );
    location.rsplit('/').next().expect("request id").to_string()
}

/// Load the Owner-facing consent prompt for `request_id` as JSON.
pub async fn get_oauth_consent(g: &Gatekeeper, host_owner_token: &str, request_id: &str) -> Value {
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get(format!("/access/oauth-consents/{request_id}"))
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {host_owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    body_json(res.into_body()).await
}

/// `POST /access/oauth-consents/{id}/approve` with an owned JSON body.
pub async fn approve_oauth_consent(
    g: &Gatekeeper,
    host_owner_token: &str,
    request_id: &str,
    body: String,
) -> axum::response::Response {
    g.router
        .clone()
        .oneshot(loopback_request(
            Request::post(format!("/access/oauth-consents/{request_id}/approve"))
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {host_owner_token}"))
                .header("content-type", "application/json"),
            Body::from(body),
        ))
        .await
        .expect("oneshot")
}

/// Drive `/authorize` → Owner consent approve for one request, returning the
/// pending request id. Callers assert on the *consequences* (grant rows,
/// fast-path behaviour, refresh issuance); the flow itself is proven by
/// `auth_code_grant_happy_path_end_to_end`. Uses the shared
/// `https://app.example/cb` redirect and [`CODE_VERIFIER`]'s challenge.
///
/// `approve_body` carries `acknowledgedRegistration` like any real approval;
/// callers seed a client whose registration already covers the request, so the
/// flag is ignored.
pub async fn authorize_and_approve(
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

pub const CHROME_MAC_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
     AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/// Plant a refresh-token family with one live token directly in the store,
/// with a caller-controlled family deadline so expiry tests don't sleep.
pub fn plant_refresh_token(
    store: &SqliteGatekeeperStore,
    plaintext: &str,
    client_id: &str,
    family_expires_at: chrono::DateTime<Utc>,
) {
    let now = Utc::now();
    store
        .insert_refresh_token_family_row(&RefreshTokenFamily {
            family_id: format!("family-{plaintext}"),
            client_id: client_id.to_string(),
            scopes: vec!["read".to_string(), "offline_access".to_string()],
            patient: None,
            issued_at: now,
            expires_at: family_expires_at,
            authorization_code_hash: None,
            grant_id: None,
        })
        .expect("insert refresh token family row");
    store
        .insert_refresh_token(&RefreshToken {
            token_hash: token_storage_hash(plaintext),
            family_id: format!("family-{plaintext}"),
            issued_at: now,
            consumed_at: None,
        })
        .expect("insert first refresh token");
}

// ---------------------------------------------------------------------------
// Confidential-client authentication (RFC 6749 §2.3.1 client_secret_basic /
// client_secret_post)
// ---------------------------------------------------------------------------

/// Register a confidential client whose argon2id `secret_hash` matches
/// `client_secret_plaintext`, through a second store handle — mirrors
/// `seed_client_with_redirect`, which can only seed public clients.
pub fn seed_confidential_client(
    db: &TestDb,
    client_id: &str,
    client_secret_plaintext: &str,
    scopes: &[&str],
) {
    let store = store_handle(db);
    store
        .upsert_client(&Client {
            client_id: client_id.to_string(),
            name: "Integration Test Confidential Client".to_string(),
            kind: ClientKind::Confidential,
            redirect_uris: vec![],
            allowed_scopes: scopes.iter().map(ToString::to_string).collect(),
            allowed_grant_types: AllowedGrantType::ALL.to_vec(),
            secret_hash: Some(hash_client_secret(client_secret_plaintext).expect("hash secret")),
            registered_at: Utc::now(),
            disabled_at: None,
        })
        .expect("register confidential client");
}

/// `post_form` plus an `Authorization` header; takes an owned body since the
/// Basic-auth tests build it with `format!`.
pub async fn post_form_with_authorization(
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
pub fn basic_authorization(client_id: &str, client_secret: &str) -> String {
    format!(
        "Basic {}",
        base64::standard_encode(format!("{client_id}:{client_secret}").as_bytes())
    )
}

pub const CONFIDENTIAL_CLIENT_ID: &str = "conf-app";
pub const CONFIDENTIAL_CLIENT_SECRET: &str = "shhh-integration-secret";

/// Spin up a gatekeeper with a seeded confidential client and a live planted
/// refresh token — the cheapest real grant to exercise client auth against.
pub fn spin_up_with_confidential_client() -> (Gatekeeper, TestDb) {
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

// ---------------------------------------------------------------------------
// Cookie-based web-session auth (#218): the device-code / refresh grants set
// the `wf_auth` (HttpOnly JWT) + `wf_auth_exp` (readable hint) cookies, the auth
// middleware accepts a cookie-sourced token identically to a header-sourced one,
// and `POST /access/logout` clears them.
// ---------------------------------------------------------------------------

/// Collect every `Set-Cookie` value off a response, in order.
pub fn set_cookie_values(res: &axum::response::Response) -> Vec<String> {
    res.headers()
        .get_all(axum::http::header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().expect("ascii Set-Cookie").to_string())
        .collect()
}

// ---------------------------------------------------------------------------
// Token revocation (#269). The auth gate enforces the shared denylist + subject
// epoch, and the control surfaces (logout, POST /access/revocations, grant
// revoke) write to it. Central invariant of the reframe: a `jti` is a
// revocation *handle*, not a single-use nonce — a live token must keep passing.
// ---------------------------------------------------------------------------

/// A second `RevocationStore` handle on the running router's shared connection,
/// so a test can plant/observe revocations the way `store_handle` does for the
/// gatekeeper store.
pub fn revocation_store_handle(db: &TestDb) -> token_revocation_rust::RevocationStore {
    token_revocation_rust::RevocationStore::new(db.revocation_conn.clone())
        .expect("revocation store handle")
}

/// Pull the `jti` out of a minted token's payload (the base64url middle
/// segment). Uses gatekeeper's own base64 helper — the bare `base64` name is
/// shadowed in this file by the `crypto_util::base64` module import at the top.
pub fn jti_of(token: &str) -> String {
    let payload_b64 = token.split('.').nth(1).expect("jwt has a payload segment");
    let payload = base64::url_safe_no_pad_decode(payload_b64).expect("payload is base64url");
    let claims: Value = serde_json::from_slice(&payload).expect("payload is json");
    claims["jti"]
        .as_str()
        .expect("minted token carries a jti")
        .to_string()
}

/// The smallest owner-gated call — used as a "does this token still
/// authenticate?" probe against the gate.
pub fn owner_grants_probe(token: &str) -> Request<Body> {
    loopback_request(
        Request::get("/access/grants")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {token}")),
        Body::empty(),
    )
}

/// Build an owner-authenticated `POST /access/revocations` with a JSON body.
pub fn owner_revocation_request(token: &str, body: Value) -> Request<Body> {
    loopback_request(
        Request::post("/access/revocations")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json"),
        Body::from(body.to_string()),
    )
}
