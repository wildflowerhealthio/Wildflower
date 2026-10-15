pub use axum::body::{to_bytes, Body};
pub use axum::http::{Request, StatusCode};
pub use tokio::sync::watch;
pub use wildflowerhealthio_authorization_server::{
    setup_authorization_server, AuthorizationServer, AuthorizationServerConfig,
    OWNER_BROWSER_CLIENT_ID, WILDFLOWER_HOST_APP_CLIENT_ID,
};

/// The server's origin: the `iss` and `aud` of every token it mints, and the
/// only ones its bearer gates accept.
pub const SERVER_ORIGIN: &str = "https://ruth.relay.example";

/// The hosted launcher the authorization server's browser-facing pages resolve on in
/// these tests — deliberately not the production address, so an assertion
/// can't pass by accident against a hard-coded one.
pub const LAUNCHER_BASE: &str = "https://launcher.test/launcher/";

/// The hosted Wildflower Authorization app in these tests, likewise not the
/// production address.
pub const AUTHORIZATION_APP_BASE: &str = "https://authorization.test/authorization/";

/// The page the host opens this server's launches in, its own launcher, which
/// isn't under the hosted one.
pub const LAUNCHER_URL: &str = "https://apps.test/launcher?theme=dark";

/// The page the host opens this server's Authorization app at, which isn't
/// under the hosted one.
pub const AUTHORIZATION_URL: &str = "https://manage.test/authorization/";
pub use chrono::{Duration, Utc};
pub use serde_json::Value;
pub use tower::ServiceExt;
pub use url::Url;
pub use wildflowerhealthio_authorization_server::crypto_util::base64;
pub use wildflowerhealthio_authorization_server::crypto_util::client_secret::hash_client_secret;
pub use wildflowerhealthio_authorization_server::crypto_util::pkce::compute_code_challenge;
pub use wildflowerhealthio_authorization_server::crypto_util::random_token::token_storage_hash;
pub use wildflowerhealthio_authorization_server::domain::authorization_code::IssuedAuthorizationCode;
pub use wildflowerhealthio_authorization_server::domain::authorization_request::{
    AuthorizationRequest, GrantType, RequestStatus,
};
pub use wildflowerhealthio_authorization_server::domain::client::{
    AllowedGrantType, Client, ClientKind,
};
pub use wildflowerhealthio_authorization_server::domain::refresh_token::{
    RefreshToken, RefreshTokenFamily,
};
pub use wildflowerhealthio_authorization_server::domain::token::{mint_access_token, NewJwtArgs};
pub use wildflowerhealthio_authorization_server::{
    GrantStore, NewestPendingConsent, SqliteGrantStore,
};
pub use wildflowerhealthio_persistence::{Connection, DieselPool};
pub use wildflowerhealthio_shared_structures::authorization_app::AuthorizationAppBase;
pub use wildflowerhealthio_shared_structures::launcher::LauncherBase;

/// The two database handles the running router uses, kept so tests can open
/// second store handles onto the SAME databases: the diesel pool behind the
/// `SqliteGrantStore` and the rusqlite connection behind the shared
/// `RevocationStore` (which stays rusqlite-backed — it is a separate crate).
pub struct TestDb {
    pool: DieselPool,
    revocation_conn: Connection,
    /// Live receiver on the newest pending consent the slice publishes — the
    /// same channel the Tauri host notifies from. Held (not dropped) so tests
    /// can assert *what the host would notify* after a request lands,
    /// which is the only observable difference between "parked a request" and
    /// "parked a request and asked the Owner about it".
    pending_consent_rx: watch::Receiver<Option<NewestPendingConsent>>,
}

/// Set up the authorization server over a fresh in-memory database, and mint
/// an Owner token for it (see [`mint_owner_token`]).
pub fn spin_up() -> (AuthorizationServer, String, TestDb) {
    // One shared in-memory diesel pool, built once and handed to the slice —
    // mirrors how the host wires the app-wide `wildflowerhealthio_persistence::open_pool`
    // pool into each diesel-backed slice. `db.pool` is that shared handle;
    // `store_handle` clones it to reach the same database.
    let pool = wildflowerhealthio_persistence::open_in_memory_pool().expect("open in-memory pool");
    let config = AuthorizationServerConfig {
        server_origin: Url::parse(SERVER_ORIGIN).expect("SERVER_ORIGIN is a valid URL"),
        host_app_client_scopes:
            wildflowerhealthio_authorization_server::default_host_app_client_scopes(),
        wildflower_host_app_client_id:
            wildflowerhealthio_authorization_server::default_wildflower_host_app_client_id(),
        fhir_ui_client_id: "fhir-ui-client".to_string(),
        launcher_base: LauncherBase::parse(LAUNCHER_BASE).expect("LAUNCHER_BASE is a valid URL"),
        authorization_app_base: AuthorizationAppBase::parse(AUTHORIZATION_APP_BASE)
            .expect("AUTHORIZATION_APP_BASE is a valid URL"),
        launcher_url: Url::parse(LAUNCHER_URL).expect("LAUNCHER_URL is a valid URL"),
        authorization_url: Url::parse(AUTHORIZATION_URL).expect("AUTHORIZATION_URL is a valid URL"),
    };
    let (pending_consent_tx, pending_consent_rx) =
        watch::channel::<Option<NewestPendingConsent>>(None);
    // The shared revocation store lives on the rusqlite connection the host
    // wires into both the authorization server and the FHIR server (#269). A second handle on
    // the same connection (see `revocation_store_handle`) lets tests
    // plant/observe rows.
    let revocation_conn = Connection::open_in_memory().expect("open revocation db");
    let revocation_store =
        wildflowerhealthio_token_revocation::RevocationStore::new(revocation_conn.clone())
            .expect("revocation store");
    let g = setup_authorization_server(pool.clone(), revocation_store, &config, pending_consent_tx)
        .expect("setup");
    let db = TestDb {
        pool,
        revocation_conn,
        pending_consent_rx,
    };
    let owner_token = mint_owner_token(&db);
    (g, owner_token, db)
}

/// The `client_id` [`mint_owner_token`]'s tokens are issued to: a client the
/// Owner has delegated their whole authority to, as they may the launcher.
/// Distinct from every client a test revokes or disables, so the Owner's token
/// outlives those.
pub const OWNER_TOKEN_CLIENT_ID: &str = "integration-test-owner-app";

/// Mint an **Owner** access token: one issued to [`OWNER_TOKEN_CLIENT_ID`]
/// holding the Owner's scopes, which cover every `/authorization/*` scope gate.
/// Signed by the seeded active key and naming [`SERVER_ORIGIN`] as `iss` and
/// `aud`, so every bearer gate accepts it.
pub fn mint_owner_token(db: &TestDb) -> String {
    let owner_scopes = wildflowerhealthio_authorization_server::owner_scopes();
    let owner_scopes: Vec<&str> = owner_scopes.iter().map(String::as_str).collect();
    mint_client_token(db, OWNER_TOKEN_CLIENT_ID, &owner_scopes)
}

/// Mint an access token issued to `client_id` carrying exactly `scopes`, signed
/// by the seeded active key and naming [`SERVER_ORIGIN`] as `iss` and `aud`.
pub fn mint_client_token(db: &TestDb, client_id: &str, scopes: &[&str]) -> String {
    let key = store_handle(db)
        .active_signing_key()
        .expect("signing-key query")
        .expect("a seeded active signing key");
    let scope: Vec<String> = scopes.iter().map(|s| (*s).to_owned()).collect();
    mint_access_token(
        &key,
        &NewJwtArgs {
            client_id,
            scopes: &scope,
            ttl: Duration::minutes(15),
            issuer: SERVER_ORIGIN,
            audience: Some(SERVER_ORIGIN),
            patient: None,
        },
    )
    .expect("mint token")
}

/// The pending consent the host would currently be showing — the latest value
/// on the slice's pending-consent watch channel.
pub fn newest_pending_consent(db: &TestDb) -> Option<NewestPendingConsent> {
    db.pending_consent_rx.borrow().clone()
}

/// A second `SqliteGrantStore` handle on the *same* shared pool the running
/// router uses. Tests reach through this to seed clients and to plant rows
/// (e.g. an already-expired authorization request) that the public HTTP
/// surface can't construct directly — preferred over real-time sleeps so the
/// expiry paths stay deterministic.
pub fn store_handle(db: &TestDb) -> SqliteGrantStore {
    SqliteGrantStore::new(db.pool.clone()).expect("store handle")
}

/// Register an OAuth client with an allowlisted `redirect_uri` through a
/// second store handle on the same shared connection. The redirect-back error
/// tests (RFC 6749 §4.1.2.1) need a client whose `redirect_uri` validates,
/// which the seeded host app's client (empty allowlist) cannot provide.
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
            redirect_uris: vec![Url::parse(redirect_uri).expect("redirect url")],
            allowed_scopes: scopes.iter().map(ToString::to_string).collect(),
            allowed_grant_types: AllowedGrantType::ALL.to_vec(),
            secret_hash: None,
            registered_at: Utc::now(),
            disabled_at: None,
        })
        .expect("register client");
}

/// The `client_id` [`seed_test_client`] registers: a stand-in for any client
/// the tests need to run a grant as, with no fixed registration.
pub const TEST_CLIENT_ID: &str = "integration-test-app";

/// The scope [`seed_test_client`]'s client is allowed: full system FHIR access,
/// so a test can ask it for a scope as broad as the Owner holds.
pub const TEST_CLIENT_SCOPE: &str = "system/*.cruds";

/// Register [`TEST_CLIENT_ID`] through a second store handle on the same
/// shared connection: a public client allowed every grant type and
/// [`TEST_CLIENT_SCOPE`], with no redirect URI.
pub fn seed_test_client(db: &TestDb) {
    store_handle(db)
        .upsert_client(&Client {
            client_id: TEST_CLIENT_ID.to_string(),
            name: "Integration Test Client".to_string(),
            kind: ClientKind::Public,
            redirect_uris: vec![],
            allowed_scopes: vec![TEST_CLIENT_SCOPE.to_string()],
            allowed_grant_types: AllowedGrantType::ALL.to_vec(),
            secret_hash: None,
            registered_at: Utc::now(),
            disabled_at: None,
        })
        .expect("register the test client");
}

/// Mint a **non-owner** access token carrying exactly `scopes`, signed by the
/// seeded active key and naming [`SERVER_ORIGIN`] as `iss` and `aud`, as every
/// token this server mints does — so it passes `require_valid_session`'s authN
/// but is authorized only up to `scopes`. Lets the scope-gating tests drive the
/// `403` path a real client token would hit, without walking the OAuth flow.
pub fn mint_scoped_token(db: &TestDb, scopes: &[&str]) -> String {
    mint_token_naming(db, scopes, SERVER_ORIGIN, SERVER_ORIGIN)
}

/// Mint a token carrying `scopes`, signed by the seeded active key, with the
/// given `iss` and `aud` — for the tests that present a token this server
/// didn't mint for itself.
pub fn mint_token_naming(db: &TestDb, scopes: &[&str], issuer: &str, audience: &str) -> String {
    let key = store_handle(db)
        .active_signing_key()
        .expect("signing-key query")
        .expect("a seeded active signing key");
    let scope: Vec<String> = scopes.iter().map(|s| (*s).to_owned()).collect();
    mint_access_token(
        &key,
        &NewJwtArgs {
            client_id: "scoped-app",
            scopes: &scope,
            ttl: Duration::seconds(300),
            issuer,
            audience: Some(audience),
            patient: None,
        },
    )
    .expect("mint token")
}

/// `builder`'s request with `body`, to drive straight into the router.
pub fn build_request(builder: http::request::Builder, body: Body) -> Request<Body> {
    builder.body(body).expect("build request")
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
    let req = build_request(
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
    store: &SqliteGrantStore,
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
            launch: None,
            launch_bound_patient: None,
        })
        .expect("insert request");
    store
        .issue_authorization_code(&IssuedAuthorizationCode {
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
    store: &SqliteGrantStore,
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
            launch: None,
            launch_bound_patient: None,
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
        .oneshot(build_request(
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

/// Assert `res` is a 302 to the authorization server's wait page and return the pending
/// request id it names — the shape every parked `/authorize` request takes.
/// How the relative `Location` resolves is pinned in `wait_page.rs`.
pub fn parked_request_id(res: &axum::response::Response) -> String {
    assert_eq!(res.status(), StatusCode::FOUND);
    let location = location_of(res);
    assert!(
        location.starts_with("authorize/") && location.ends_with("/wait"),
        "expected a wait-page redirect, got {location}"
    );
    polling_request_id(&location)
}

/// The pending request id a wait-page `Location` (`authorize/{id}/wait`,
/// relative to `/oauth/authorize`) names: the segment before `wait`.
pub fn polling_request_id(wait_page_location: &str) -> String {
    let url = Url::parse(SERVER_ORIGIN)
        .and_then(|origin| origin.join("/oauth/authorize"))
        .and_then(|authorize| authorize.join(wait_page_location))
        .expect("the wait-page location resolves");
    let mut segments = url.path_segments().expect("an absolute path");
    assert_eq!(segments.next_back(), Some("wait"), "{url}");
    segments.next_back().expect("request id").to_string()
}

/// Load the Owner-facing consent prompt for `request_id` as JSON.
pub async fn get_oauth_consent(
    g: &AuthorizationServer,
    owner_token: &str,
    request_id: &str,
) -> Value {
    let res = g
        .router
        .clone()
        .oneshot(build_request(
            Request::get(format!("/authorization/oauth-consents/{request_id}"))
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    body_json(res.into_body()).await
}

/// `POST /authorization/oauth-consents/{id}/approve` with an owned JSON body.
pub async fn approve_oauth_consent(
    g: &AuthorizationServer,
    owner_token: &str,
    request_id: &str,
    body: String,
) -> axum::response::Response {
    g.router
        .clone()
        .oneshot(build_request(
            Request::post(format!(
                "/authorization/oauth-consents/{request_id}/approve"
            ))
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {owner_token}"))
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
    g: &AuthorizationServer,
    owner_token: &str,
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
        .oneshot(build_request(
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
    let request_id = polling_request_id(&polling);
    let approve = build_request(
        Request::post(format!(
            "/authorization/oauth-consents/{request_id}/approve"
        ))
        .header("host", "127.0.0.1")
        .header("authorization", format!("Bearer {owner_token}"))
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
    store: &SqliteGrantStore,
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
    let req = build_request(
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

/// Spin up an authorization server with a seeded confidential client and a live planted
/// refresh token — the cheapest real grant to exercise client auth against.
pub fn spin_up_with_confidential_client() -> (AuthorizationServer, TestDb) {
    let (g, _owner_token, db) = spin_up();
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
// Bearer-only auth: no grant or logout response sets a cookie, and a cookie
// authenticates nothing (see `bearer_only.rs`).
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
// epoch, and the control surfaces (logout, POST /authorization/revocations, grant
// revoke) write to it. Central invariant of the reframe: a `jti` is a
// revocation *handle*, not a single-use nonce — a live token must keep passing.
// ---------------------------------------------------------------------------

/// A second `RevocationStore` handle on the running router's shared connection,
/// so a test can plant/observe revocations the way `store_handle` does for the
/// grant store.
pub fn revocation_store_handle(
    db: &TestDb,
) -> wildflowerhealthio_token_revocation::RevocationStore {
    wildflowerhealthio_token_revocation::RevocationStore::new(db.revocation_conn.clone())
        .expect("revocation store handle")
}

/// Pull the `jti` out of a minted token's payload (the base64url middle
/// segment). Uses the authorization server's own base64 helper — the bare `base64` name is
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
    build_request(
        Request::get("/authorization/grants")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {token}")),
        Body::empty(),
    )
}

/// Build an owner-authenticated `POST /authorization/revocations` with a JSON body.
pub fn owner_revocation_request(token: &str, body: Value) -> Request<Body> {
    build_request(
        Request::post("/authorization/revocations")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json"),
        Body::from(body.to_string()),
    )
}

/// `PATCH /authorization/clients/{client_id}` with the raw JSON `body`, as `token`.
pub async fn patch_client(
    g: &AuthorizationServer,
    token: &str,
    client_id: &str,
    body: &Value,
) -> axum::response::Response {
    g.router
        .clone()
        .oneshot(build_request(
            Request::patch(format!("/authorization/clients/{client_id}"))
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json"),
            Body::from(body.to_string()),
        ))
        .await
        .expect("oneshot")
}

/// Disable `client_id` as of `at`, sent as the UTC string the launcher sends.
pub async fn disable_client(
    g: &AuthorizationServer,
    token: &str,
    client_id: &str,
    at: chrono::DateTime<Utc>,
) -> axum::response::Response {
    let disabled_at = at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    patch_client(
        g,
        token,
        client_id,
        &serde_json::json!({ "disabledAt": disabled_at }),
    )
    .await
}

/// Re-enable `client_id` (`disabledAt: null`).
pub async fn enable_client(
    g: &AuthorizationServer,
    token: &str,
    client_id: &str,
) -> axum::response::Response {
    patch_client(
        g,
        token,
        client_id,
        &serde_json::json!({ "disabledAt": null }),
    )
    .await
}

/// Assert `res` carries both cache-suppression headers — `Cache-Control:
/// no-store` and `Pragma: no-cache` — each exactly once. `what` names the
/// response in the failure message.
pub fn assert_cache_suppressed(res: &axum::response::Response, what: &str) {
    let values = |name: &str| -> Vec<&str> {
        res.headers()
            .get_all(name)
            .iter()
            .map(|v| v.to_str().expect("ascii header"))
            .collect()
    };
    assert_eq!(
        values("cache-control"),
        ["no-store"],
        "{what} must carry exactly one Cache-Control: no-store"
    );
    assert_eq!(
        values("pragma"),
        ["no-cache"],
        "{what} must carry exactly one Pragma: no-cache"
    );
}

// ---------------------------------------------------------------------------
// Owner sign-in (#1098): a code the base mints signs a browser in as the
// Owner, handing it the Owner browser session cookie.
// ---------------------------------------------------------------------------

/// `GET /oauth/sign-in` with `code` and `next`, as the browser the base opened
/// sends it.
pub async fn sign_in(g: &AuthorizationServer, code: &str, next: &str) -> axum::response::Response {
    let uri = format!(
        "/oauth/sign-in?{}",
        url::form_urlencoded::Serializer::new(String::new())
            .append_pair("code", code)
            .append_pair("next", next)
            .finish()
    );
    g.router
        .clone()
        .oneshot(build_request(Request::get(uri), Body::empty()))
        .await
        .expect("oneshot")
}

/// The Owner token a sign-in's `Set-Cookie` hands the browser.
pub fn owner_browser_session_token(res: &axum::response::Response) -> String {
    let cookies = set_cookie_values(res);
    let [cookie] = cookies.as_slice() else {
        panic!("exactly one cookie, got {cookies:?}");
    };
    cookie
        .strip_prefix("__Host-owner_browser_session=")
        .and_then(|rest| rest.split(';').next())
        .unwrap_or_else(|| panic!("the Owner browser session cookie, got {cookie}"))
        .to_owned()
}

/// Sign a browser in as the Owner, returning the Owner browser token its
/// `__Host-owner_browser_session` cookie holds.
pub async fn signed_in_owner_browser_token(g: &AuthorizationServer) -> String {
    let code = g.same_device_sign_in_code_minter.mint();
    owner_browser_session_token(&sign_in(g, &code, "/").await)
}
