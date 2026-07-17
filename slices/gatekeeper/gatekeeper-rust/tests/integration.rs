use std::net::SocketAddr;

use axum::body::{to_bytes, Body};
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use gatekeeper_rust::{
    setup_gatekeeper, Gatekeeper, GatekeeperConfig, WILDFLOWER_LOCAL_GRANTED_SCOPES,
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
use gatekeeper_rust::domain::token::{mint_access_token, NewJwtArgs};
use gatekeeper_rust::{GatekeeperStore, SqliteGatekeeperStore};
use persistence_rust::{Connection, DieselPool};
use serde_json::Value;
use tower::ServiceExt;
use url::Url;

/// The two database handles the running router uses, kept so tests can open
/// second store handles onto the SAME databases: the diesel pool behind the
/// `SqliteGatekeeperStore` and the rusqlite connection behind the shared
/// `RevocationStore` (which stays rusqlite-backed — it is a separate crate).
struct TestDb {
    pool: DieselPool,
    revocation_conn: Connection,
}

fn spin_up() -> (Gatekeeper, String, TestDb) {
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
    let (active_device_tx, _active_device_rx) = watch::channel::<Option<String>>(None);
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
        active_device_tx,
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
        },
    )
}

/// A second `SqliteGatekeeperStore` handle on the *same* shared pool the running
/// router uses. Tests reach through this to seed clients and to plant rows
/// (e.g. an already-expired authorization request) that the public HTTP
/// surface can't construct directly — preferred over real-time sleeps so the
/// expiry paths stay deterministic.
fn store_handle(db: &TestDb) -> SqliteGatekeeperStore {
    SqliteGatekeeperStore::new(db.pool.clone()).expect("store handle")
}

/// Register an OAuth client with an allowlisted `redirect_uri` through a
/// second store handle on the same shared connection. The redirect-back error
/// tests (RFC 6749 §4.1.2.1) need a client whose `redirect_uri` validates,
/// which the seeded first-party client (empty allowlist) cannot provide.
fn seed_client_with_redirect(db: &TestDb, client_id: &str, redirect_uri: &str, scopes: &[&str]) {
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

/// Mint a **non-owner** access token carrying exactly `scopes`, signed by the
/// seeded active key. `iss` is the canonical issuer (as every mint is) and `aud`
/// is the loopback served origin (NOT the canonical audience, which is reserved
/// for the `wf_owner`-marked host token) — so it passes `require_valid_session`'s
/// authN but is authorized only up to `scopes`. Lets the scope-gating tests drive
/// the `403` path a real client token would hit, without walking the OAuth flow.
fn mint_scoped_token(db: &TestDb, scopes: &[&str]) -> String {
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
async fn bearer_gate_inserts_scope_claims_a_downstream_capability_reads() {
    // Cross-slice contract: the databases router's per-database scope gate only
    // works because gatekeeper's bearer gate inserts a `ScopeClaims` into the
    // request extensions. Drive the real producer (the gate) and the real
    // consumer (databases' `Scoped<DatabasesReader>`) together — if the gate ever
    // stopped inserting `ScopeClaims`, every gated `/databases` request would 500
    // instead of 200/403, and only this test would catch it (the slice's own
    // tests fabricate the extension).
    use gatekeeper_rust::layer_router_with_gatekeeper_auth_gating;

    let (g, host_owner_token, db) = spin_up();

    // A one-database catalogue gated by `wildflower/*` read/delete, backed by a
    // real on-disk SQLite file so the metadata read + snapshot have something to
    // work against.
    let dir = tempfile::tempdir().expect("tempdir");
    let db_id = "wildflower.sqlite";
    {
        let conn = rusqlite::Connection::open(dir.path().join(db_id)).expect("seed db");
        conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY);")
            .expect("seed table");
    }
    let config = databases_rust::DatabasesConfig {
        data_dir: dir.path().to_path_buf(),
        databases: vec![databases_rust::DatabaseDescriptor {
            id: db_id.to_owned(),
            label: "Wildflower app data".to_owned(),
            description: "App state.".to_owned(),
            read_scope: scopes_rust::Scope::wildflower_all(scopes_rust::Permission::READ),
            delete_scope: scopes_rust::Scope::wildflower_all(scopes_rust::Permission::DELETE),
        }],
    };
    let gated = layer_router_with_gatekeeper_auth_gating(
        databases_rust::setup_databases(&config),
        g.state.clone(),
        &[],
    );

    let get = |path: String, token: Option<String>| {
        let gated = gated.clone();
        async move {
            let mut builder = Request::get(&path);
            if let Some(token) = token {
                builder = builder.header("authorization", format!("Bearer {token}"));
            }
            gated
                .oneshot(loopback_request(builder, Body::empty()))
                .await
                .expect("oneshot")
                .status()
        }
    };

    // No token → 401 at the gate, before any capability runs.
    assert_eq!(
        get(format!("/databases/{db_id}"), None).await,
        StatusCode::UNAUTHORIZED,
    );
    // Owner token (covers `wildflower/*`) → the capability builds and streams the
    // snapshot: proof the gate inserted a `ScopeClaims` the extractor could read.
    assert_eq!(
        get(format!("/databases/{db_id}"), Some(host_owner_token)).await,
        StatusCode::OK,
    );
    // A valid token that does NOT cover the database's read scope → 403 from the
    // capability (NOT a 500): the extractor read the inserted claims and found
    // them insufficient.
    let under_scoped = mint_scoped_token(&db, &["system/Observation.r"]);
    assert_eq!(
        get(format!("/databases/{db_id}"), Some(under_scoped)).await,
        StatusCode::FORBIDDEN,
    );
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

/// The host owner token must authenticate on a FORWARDED (tunnel-origin)
/// request too — it rides the `wf_auth` cookie seeded into the cloud-app popup
/// (#256), where the served origin is the tunnel public host, not loopback.
/// Its canonical `aud` (= `CANONICAL_ISSUER`) is what makes one token valid on
/// both; a served-origin audience would 401 here.
#[tokio::test]
async fn access_grants_with_owner_token_passes_on_forwarded_tunnel_origin() {
    let (g, host_owner_token, _db) = spin_up();
    let req = loopback_request(
        Request::get("/access/grants")
            .header("host", "127.0.0.1")
            .header(
                "forwarded",
                "host=ruth.wildflowerhealth.example;proto=https",
            )
            .header("authorization", format!("Bearer {host_owner_token}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
}

/// The canonical audience is accepted at every served origin, so it is reserved
/// for the marked host owner token. A token that carries `aud = CANONICAL_ISSUER`
/// AND the owner-defining scopes but LACKS the `wf_owner` marker — an otherwise
/// owner-shaped token, the exact shape a future minting bug or a replay would
/// produce — is rejected. Only the missing marker distinguishes it from the
/// token that passes on line above, so this pins the marker as the gate.
#[tokio::test]
async fn canonical_audience_without_owner_marker_is_rejected() {
    let (g, _host_owner_token, db) = spin_up();
    let key = store_handle(&db)
        .active_signing_key()
        .expect("signing-key query")
        .expect("a seeded active signing key");
    let scopes = gatekeeper_rust::default_local_granted_scopes();
    let unmarked = mint_access_token(
        &key,
        &NewJwtArgs {
            client_id: "impostor",
            scope: &scopes,
            ttl: Duration::seconds(300),
            origin: shared_structures_rust::CANONICAL_ISSUER,
            audience: Some(shared_structures_rust::CANONICAL_ISSUER),
            patient: None,
            is_host_owner: false,
        },
    )
    .expect("mint");
    let req = loopback_request(
        Request::get("/access/grants")
            .header("host", "127.0.0.1")
            .header(
                "forwarded",
                "host=ruth.wildflowerhealth.example;proto=https",
            )
            .header("authorization", format!("Bearer {unmarked}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
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

// --- Scope-gated `/access` authorization (resource-based authz, #261) ---------
//
// authN (a valid token) is proven above via 401; these pin authZ: a valid but
// under-scoped token is a 403 naming the missing scope, the exact-scope token
// passes the gate, and a resource wildcard covers its resource — the coverage
// engine driving real endpoints.

#[tokio::test]
async fn access_grants_list_with_grant_read_scope_returns_200() {
    let (g, _host_owner_token, db) = spin_up();
    let token = mint_scoped_token(&db, &["wildflower/Grant.r"]);
    let req = loopback_request(
        Request::get("/access/grants")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {token}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res.into_body()).await, serde_json::json!([]));
}

#[tokio::test]
async fn access_grants_list_with_wildflower_wildcard_returns_200() {
    // `wildflower/*.cruds` covers `wildflower/Grant.r` — a non-owner token that
    // holds the Wildflower wildcard still passes the per-resource gate.
    let (g, _host_owner_token, db) = spin_up();
    let token = mint_scoped_token(&db, &["wildflower/*.cruds"]);
    let req = loopback_request(
        Request::get("/access/grants")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {token}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn access_grants_delete_with_only_read_scope_returns_403_missing_delete() {
    // A valid token scoped to read-only is authenticated (not a 401) but
    // unauthorized to revoke — the gate rejects with 403 BEFORE the handler, so
    // even a non-existent id is a 403, never a 404.
    let (g, _host_owner_token, db) = spin_up();
    let token = mint_scoped_token(&db, &["wildflower/Grant.r"]);
    let req = loopback_request(
        Request::delete("/access/grants/any-id")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {token}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let body = body_json(res.into_body()).await;
    assert_eq!(body["error"], "InsufficientScope");
    assert_eq!(
        body["missingScopes"],
        serde_json::json!(["wildflower/Grant.d"]),
    );
}

#[tokio::test]
async fn access_grants_delete_with_grant_delete_scope_passes_the_gate() {
    // The `Grant.d` scope clears the gate, so the handler runs and reports the
    // missing grant as a 404 — proving the gate admitted the request (not a 403).
    let (g, _host_owner_token, db) = spin_up();
    let token = mint_scoped_token(&db, &["wildflower/Grant.d"]);
    let req = loopback_request(
        Request::delete("/access/grants/nope")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {token}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    assert_eq!(body_json(res.into_body()).await["error"], "GrantNotFound");
}

#[tokio::test]
async fn access_revocations_requires_token_delete_scope() {
    let (g, _host_owner_token, db) = spin_up();
    // A `Grant.r` token can't revoke tokens — 403 naming `wildflower/Token.d`.
    let under_scoped = mint_scoped_token(&db, &["wildflower/Grant.r"]);
    let req = loopback_request(
        Request::post("/access/revocations")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {under_scoped}"))
            .header("content-type", "application/json"),
        Body::from(r#"{"subject":"some-client"}"#),
    );
    let res = g.router.clone().oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        body_json(res.into_body()).await["missingScopes"],
        serde_json::json!(["wildflower/Token.d"]),
    );

    // A `Token.d` token clears the gate and the subject epoch bump succeeds.
    let authorized = mint_scoped_token(&db, &["wildflower/Token.d"]);
    let req = loopback_request(
        Request::post("/access/revocations")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {authorized}"))
            .header("content-type", "application/json"),
        Body::from(r#"{"subject":"some-client"}"#),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn access_logout_is_self_service_any_valid_bearer() {
    // Logout takes no admin scope: a token with an unrelated, narrow scope still
    // logs itself out (303 redirect), because it only needs authN.
    let (g, _host_owner_token, db) = spin_up();
    let token = mint_scoped_token(&db, &["wildflower/Grant.r"]);
    let req = loopback_request(
        Request::post("/access/logout")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {token}")),
        Body::empty(),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::SEE_OTHER);
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
async fn authorize_allows_scope_covered_by_a_broader_allowed_scope() {
    // The allowlist check is coverage-aware, not exact string membership: a
    // client allowed `patient/Observation.rs` also admits a request for the
    // narrower `patient/Observation.r` it covers — parking a pending request
    // like any allowed scope (no `error=` redirect back to the client).
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["patient/Observation.rs"],
    );
    let challenge = compute_code_challenge(CODE_VERIFIER);
    let query = format!(
        "response_type=code&code_challenge_method=S256&client_id=test-app&\
         scope=patient%2FObservation.r&code_challenge={challenge}&\
         redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz"
    );
    let res = g
        .router
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
    assert!(
        !location.contains("error="),
        "a covered scope must not trigger an error redirect, got {location}"
    );
}

#[tokio::test]
async fn authorize_rejects_cross_grammar_scope_requests() {
    // Deliberate decision: coverage never bridges the SMART v1 word and v2
    // letter grammars (mirroring scopes-core). A client registered with the v1
    // `patient/Observation.read` does NOT admit a request for the
    // letter-equivalent `patient/Observation.rs` — v1 apps request v1 scopes.
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["patient/Observation.read"],
    );
    let challenge = compute_code_challenge(CODE_VERIFIER);
    let query = format!(
        "response_type=code&code_challenge_method=S256&client_id=test-app&\
         scope=patient%2FObservation.rs&code_challenge={challenge}&\
         redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz"
    );
    let res = g
        .router
        .oneshot(loopback_request(
            Request::get(format!("/oauth/authorize?{query}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::FOUND);
    let location = res.headers().get("location").expect("location header");
    assert_eq!(
        location,
        "https://app.example/cb?error=invalid_scope&state=xyz"
    );
}

#[tokio::test]
async fn authorize_accepts_smart_launch_and_aud_params() {
    // SMART App Launch forwards `launch` (the EHR-minted nonce) and `aud`
    // (the FHIR base URL the app expects) alongside the standard authorize
    // params. They're optional (`#[serde(default)]`) and not validated today,
    // so a request carrying them must validate exactly like one without them:
    // park a pending request and 302 to the owner polling page — never an
    // `error=` redirect back to the client.
    let (g, _host_owner_token, db) = spin_up();
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

#[tokio::test]
async fn device_authorization_happy_path() {
    let (g, _host_owner_token, _db) = spin_up();
    let body = "client_id=wildflower-host&scope=system%2F*.cruds";
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
async fn device_authorization_allows_scope_covered_by_client_wildcard() {
    // Coverage-aware allowlist (not exact string membership): the host client is
    // allowed `system/*.cruds`, which covers a request for the narrower
    // `system/Observation.rs`. The old exact-match gate rejected this with
    // `invalid_scope`; now it issues a device/user code pair like any allowed
    // scope.
    let (g, _host_owner_token, _db) = spin_up();
    let body = "client_id=wildflower-host&scope=system%2FObservation.rs";
    let req = loopback_request(
        Request::post("/oauth/device_authorization")
            .header("content-type", "application/x-www-form-urlencoded"),
        Body::from(body),
    );
    let res = g.router.oneshot(req).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn device_authorization_unknown_client_returns_401() {
    let (g, _host_owner_token, _db) = spin_up();
    let body = "client_id=ghost&scope=system%2F*.cruds";
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
fn plant_device_request(
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
    // The approve response's inline-completion redirect must target the client's
    // `redirect_uri` and carry both the redeemable `code` and the client's `state`.
    let approve_body = body_json(res.into_body()).await;
    assert_eq!(approve_body["status"], "approved");
    let approve_redirect = approve_body["redirect"].as_str().expect("approve redirect");
    assert!(
        approve_redirect.starts_with("https://app.example/cb"),
        "approve redirect should target the client redirect_uri, got {approve_redirect}"
    );
    let (approve_code, approve_state) = {
        let url = Url::parse(approve_redirect).expect("approve redirect url");
        let code = url
            .query_pairs()
            .find(|(k, _)| k == "code")
            .map(|(_, v)| v.into_owned())
            .expect("approve code param");
        let state = url
            .query_pairs()
            .find(|(k, _)| k == "state")
            .map(|(_, v)| v.into_owned())
            .expect("approve state param");
        (code, state)
    };
    assert_eq!(approve_state, "xyz");

    // 3. The status poll now reports Approved and hands back the client
    //    redirect carrying the redeemable `code`. It must agree with the code
    //    the approve response already returned.
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
    assert_eq!(
        code, approve_code,
        "approve-response code and poll code must agree"
    );

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

/// `GET /oauth-consents/{id}` names the app: alongside the raw `clientId`,
/// the payload carries the registered client's display name so the consent UI
/// can lead with something a patient can recognize.
#[tokio::test]
async fn oauth_consent_prompt_carries_client_display_name() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let challenge = compute_code_challenge(CODE_VERIFIER);

    // /authorize parks a pending request the Owner UI would then load.
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
    let consent = body_json(res.into_body()).await;
    assert_eq!(consent["clientId"], "test-app");
    assert_eq!(consent["clientName"], "Integration Test Client");
}

/// The Owner may *narrow* a requested scope at consent time: a request for
/// `patient/Observation.rs` approved as the tighter `patient/Observation.s` is
/// still ⊆ the request, so `grantable_scopes` keeps it (coverage, not exact
/// equality). The flow must approve — not deny — and the minted token must
/// carry the narrowed `patient/Observation.s`. Guards the covers-based
/// `is_requested` change in `scopes_rust::grantable_scopes`.
#[tokio::test]
async fn auth_code_grant_owner_narrows_requested_scope() {
    let (g, host_owner_token, db) = spin_up();
    // The client is allowed the broader `.rs`; the request asks for `.rs`.
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["patient/Observation.rs"],
    );
    let challenge = compute_code_challenge(CODE_VERIFIER);

    // 1. /authorize parks a pending request for `patient/Observation.rs`.
    let query = format!(
        "response_type=code&code_challenge_method=S256&client_id=test-app&\
         scope=patient%2FObservation.rs&code_challenge={challenge}&\
         redirect_uri=https%3A%2F%2Fapp.example%2Fcb&state=xyz"
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

    // 2. Owner approves the *narrowed* `.s` — tighter than the requested `.rs`.
    let approve = loopback_request(
        Request::post(format!("/access/oauth-consents/{request_id}/approve"))
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {host_owner_token}"))
            .header("content-type", "application/json"),
        Body::from(r#"{"approvedScopes":["patient/Observation.s"]}"#),
    );
    let res = g.router.clone().oneshot(approve).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    // Approved (NOT denied): the narrowed scope is covered by the request.
    let approve_body = body_json(res.into_body()).await;
    assert_eq!(approve_body["status"], "approved");
    let code = Url::parse(approve_body["redirect"].as_str().expect("redirect"))
        .expect("redirect url")
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned())
        .expect("code param");

    // 3. /token redeems the code; the grant carries the narrowed `.s`.
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
    assert_eq!(token["scope"], "patient/Observation.s");
}

/// Decode a JWT's payload (the middle base64url-no-pad segment) to JSON. The
/// signature isn't verified — fine for asserting claim *shape* in a test.
fn decode_jwt_payload(token: &str) -> serde_json::Value {
    let payload_b64 = token.split('.').nth(1).expect("jwt payload segment");
    let bytes = base64::url_safe_no_pad_decode(payload_b64).expect("base64url payload");
    serde_json::from_slice(&bytes).expect("payload json")
}

/// HFS authorizes FHIR reads off the token's `scope` claim, parsing only the
/// SMART v2 letter grammar — so a v1-worded grant must be minted with its
/// letter-form alternate alongside it. The app-facing `TokenResponse.scope`
/// stays the granted set verbatim.
#[tokio::test]
async fn minted_jwt_scope_claim_carries_alternate_canonical_forms() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["patient/Observation.read"],
    );
    let request_id = authorize_and_approve(
        &g,
        &host_owner_token,
        "test-app",
        "patient%2FObservation.read",
        r#"{"approvedScopes":["patient/Observation.read"]}"#,
    )
    .await;

    // Poll the approved request for the client redirect carrying the code.
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get(format!("/oauth/authorize/{request_id}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    let status = body_json(res.into_body()).await;
    let redirect = status["redirect"].as_str().expect("redirect");
    let code = Url::parse(redirect)
        .expect("redirect url")
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned())
        .expect("code param");

    // Redeem the code for a token.
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

    // App-facing `scope` is the granted set, unexpanded.
    assert_eq!(token["scope"], "patient/Observation.read");

    // The signed JWT carries both the v1 word and its v2 letter twin.
    let access_token = token["access_token"].as_str().expect("access_token");
    let claims = decode_jwt_payload(access_token);
    let scope_claim = claims["scope"].as_str().expect("scope claim");
    let claim_scopes: Vec<&str> = scope_claim.split_whitespace().collect();
    assert!(
        claim_scopes.contains(&"patient/Observation.read")
            && claim_scopes.contains(&"patient/Observation.rs"),
        "JWT scope claim must carry both v1 and v2 forms, got {scope_claim:?}"
    );
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
            "grantType": "authorization_code",
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
    // The code-flow grant serializes as the `authorization_code` variant of the
    // grantType-tagged union, carrying its redirectUri.
    assert_eq!(body[0]["grantType"], "authorization_code");
    assert_eq!(body[0]["redirectUri"], "https://app.example/cb");
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
        &[&WILDFLOWER_LOCAL_GRANTED_SCOPES[0].to_string()],
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
        &[&WILDFLOWER_LOCAL_GRANTED_SCOPES[0].to_string()],
        RequestStatus::Approved,
        Utc::now() + Duration::minutes(5),
    );
    let body = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&\
                client_id=wildflower-host&device_code=dev-approved";
    let first = post_form(&g.router, "/oauth/token", body).await;
    assert_eq!(first.status(), StatusCode::OK);
    let token = body_json(first.into_body()).await;
    assert_eq!(token["token_type"], "Bearer");
    assert_eq!(
        token["scope"],
        WILDFLOWER_LOCAL_GRANTED_SCOPES[0].to_string()
    );

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

/// Device-flow consent is EXPANDABLE: the Owner pairing a device may grant
/// scopes the device never requested, up to the client's `allowed_scopes`.
/// (The code-flow path stays clamped to `requested_scopes` — a third-party app
/// can't widen its own grant; see `device_consent_clamps_granted_scopes_to_client_allowed`
/// for the still-enforced allowed-scopes ceiling.)
#[tokio::test]
async fn device_consent_allows_expansion_beyond_requested() {
    let (g, host_owner_token, db) = spin_up();
    // The client is allowed both read and write.
    seed_client_with_redirect(
        &db,
        "device-client",
        "https://app.example/cb",
        &["read", "write"],
    );
    // ...but the device requested only `read`.
    plant_device_request(
        &store_handle(&db),
        "device-client",
        "dev-expand",
        &["read"],
        RequestStatus::Pending,
        Utc::now() + Duration::minutes(5),
    );

    // The Owner grants the un-requested-but-allowed `write` on top of `read`.
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

    // The expansion is persisted onto the grant — `write` was never requested.
    let request = store_handle(&db)
        .authorization_request_by_id("dev-expand")
        .expect("query request")
        .expect("request present");
    let granted = request.granted_scopes.expect("granted scopes");
    assert!(granted.contains(&"read".to_string()));
    assert!(granted.contains(&"write".to_string()));
}

/// The device-authorization request carries the human-chosen `device_name`
/// extension end to end: minted at `/oauth/device_authorization`, stored on the
/// request, and surfaced (alongside the client's `allowedScopes` expansion
/// envelope) on the `/access/devices/{userCode}` consent prompt.
#[tokio::test]
async fn device_authorization_carries_device_name_to_consent() {
    let (g, host_owner_token, _db) = spin_up();
    // Start the flow with a device name (URL-encoded, includes a space + apostrophe).
    let start = loopback_request(
        Request::post("/oauth/device_authorization")
            .header("content-type", "application/x-www-form-urlencoded"),
        Body::from("client_id=wildflower-host&scope=system%2F*.cruds&device_name=Ada%27s%20laptop"),
    );
    let res = g.router.clone().oneshot(start).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let user_code = body_json(res.into_body()).await["user_code"]
        .as_str()
        .expect("user_code")
        .to_string();

    // The consent prompt surfaces the device name and a non-empty expansion envelope.
    let get = loopback_request(
        Request::get(format!("/access/devices/{user_code}"))
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {host_owner_token}")),
        Body::empty(),
    );
    let res = g.router.clone().oneshot(get).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let consent = body_json(res.into_body()).await;
    assert_eq!(consent["deviceName"], "Ada's laptop");
    assert!(consent["allowedScopes"]
        .as_array()
        .expect("allowedScopes array")
        .iter()
        .any(|scope| scope == "system/*.cruds"));
}

const CHROME_MAC_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
     AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/// When a device-code client doesn't name itself, a friendly name is inferred
/// from its `User-Agent` and surfaced on the consent prompt (and later keyed on
/// by the durable grant). A browser-shaped UA becomes "Browser on OS".
#[tokio::test]
async fn device_authorization_infers_device_name_from_user_agent_when_unnamed() {
    let (g, host_owner_token, _db) = spin_up();
    // No `device_name` in the body — only a browser User-Agent.
    let start = loopback_request(
        Request::post("/oauth/device_authorization")
            .header("content-type", "application/x-www-form-urlencoded")
            .header("user-agent", CHROME_MAC_USER_AGENT),
        Body::from("client_id=wildflower-host&scope=system%2F*.cruds"),
    );
    let res = g.router.clone().oneshot(start).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let user_code = body_json(res.into_body()).await["user_code"]
        .as_str()
        .expect("user_code")
        .to_string();

    let get = loopback_request(
        Request::get(format!("/access/devices/{user_code}"))
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {host_owner_token}")),
        Body::empty(),
    );
    let res = g.router.clone().oneshot(get).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        body_json(res.into_body()).await["deviceName"],
        "Chrome on macOS"
    );
}

/// A client-supplied `device_name` is never overridden by the User-Agent
/// inference — the explicit name wins even when a recognizable UA is present.
#[tokio::test]
async fn explicit_device_name_wins_over_user_agent_inference() {
    let (g, host_owner_token, _db) = spin_up();
    let start = loopback_request(
        Request::post("/oauth/device_authorization")
            .header("content-type", "application/x-www-form-urlencoded")
            .header("user-agent", CHROME_MAC_USER_AGENT),
        Body::from("client_id=wildflower-host&scope=system%2F*.cruds&device_name=Ada%27s%20laptop"),
    );
    let res = g.router.clone().oneshot(start).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let user_code = body_json(res.into_body()).await["user_code"]
        .as_str()
        .expect("user_code")
        .to_string();

    let get = loopback_request(
        Request::get(format!("/access/devices/{user_code}"))
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {host_owner_token}")),
        Body::empty(),
    );
    let res = g.router.clone().oneshot(get).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        body_json(res.into_body()).await["deviceName"],
        "Ada's laptop"
    );
}

/// The settings approver may rename the device before approving — the adjusted
/// `deviceName` on the approve body is persisted onto the request (`COALESCE`d,
/// so an omitted name leaves the stored one intact).
#[tokio::test]
async fn device_consent_approver_can_adjust_device_name() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "device-client", "https://app.example/cb", &["read"]);
    plant_device_request(
        &store_handle(&db),
        "device-client",
        "dev-rename",
        &["read"],
        RequestStatus::Pending,
        Utc::now() + Duration::minutes(5),
    );

    let approve = loopback_request(
        Request::post("/access/devices/WILD-FLWR/approve")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {host_owner_token}"))
            .header("content-type", "application/json"),
        Body::from(r#"{"approvedScopes":["read"],"deviceName":"Reception iPad"}"#),
    );
    let res = g.router.clone().oneshot(approve).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);

    let request = store_handle(&db)
        .authorization_request_by_id("dev-rename")
        .expect("query request")
        .expect("request present");
    assert_eq!(request.device_name.as_deref(), Some("Reception iPad"));
}

/// The headline behavior of this ticket: approving a device-code consent mints a
/// **durable device grant** (the record "Authorized Devices" in Settings lists),
/// and the family the device's `offline_access` token starts links back to that
/// grant. This is the device-flow half of the "family carries grant_id for both
/// flows" contract; `offline_access_issues_rotating_refresh_token` is the
/// code-flow half.
#[tokio::test]
async fn device_approval_mints_durable_grant_and_links_refresh_family() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "device-client",
        "https://app.example/cb",
        &["read", "offline_access"],
    );
    plant_device_request(
        &store_handle(&db),
        "device-client",
        "dev-durable",
        &["read", "offline_access"],
        RequestStatus::Pending,
        Utc::now() + Duration::minutes(5),
    );

    // Approve, naming the device.
    let approve = loopback_request(
        Request::post("/access/devices/WILD-FLWR/approve")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {host_owner_token}"))
            .header("content-type", "application/json"),
        Body::from(r#"{"approvedScopes":["read","offline_access"],"deviceName":"Reception iPad"}"#),
    );
    let res = g.router.clone().oneshot(approve).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);

    // A durable device grant now shows in the access index as the `device_code`
    // union variant, titled by its deviceName.
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
    let grants = body_json(res.into_body()).await;
    let device_grant = grants
        .as_array()
        .expect("grants array")
        .iter()
        .find(|grant| grant["grantType"] == "device_code")
        .expect("a device grant was minted");
    assert_eq!(device_grant["deviceName"], "Reception iPad");
    assert_eq!(device_grant["clientId"], "device-client");
    let scopes = device_grant["scopes"].as_array().expect("scopes array");
    assert!(scopes.iter().any(|scope| scope == "read"));
    assert!(scopes.iter().any(|scope| scope == "offline_access"));

    // Redeeming the device_code issues the offline_access refresh token, whose
    // family links back to the device grant just minted.
    let body = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&\
                client_id=device-client&device_code=dev-durable";
    let res = post_form(&g.router, "/oauth/token", body).await;
    assert_eq!(res.status(), StatusCode::OK);
    let refresh = body_json(res.into_body()).await["refresh_token"]
        .as_str()
        .expect("offline_access refresh token")
        .to_string();

    let (_, family) = store_handle(&db)
        .refresh_token_with_family_by_hash(&token_storage_hash(&refresh))
        .expect("family query")
        .expect("family present");
    assert_eq!(
        family.grant_id.as_deref(),
        Some(device_grant["id"].as_str().expect("grant id")),
    );
}

/// A client restricted to a grant-type subset is refused a grant outside it
/// (RFC 6749 §5.2 `unauthorized_client`). Here a code-only client is rejected
/// at the refresh-token grant before any token lookup.
#[tokio::test]
async fn token_endpoint_rejects_grant_outside_client_allow_list() {
    let (g, _host_owner_token, db) = spin_up();
    store_handle(&db)
        .upsert_client(&Client {
            client_id: "code-only".to_string(),
            name: "Code-only client".to_string(),
            kind: ClientKind::Public,
            redirect_uris: vec![Url::parse("https://app.example/cb").unwrap()],
            allowed_scopes: vec!["read".to_string(), "offline_access".to_string()],
            allowed_grant_types: vec![AllowedGrantType::AuthorizationCode],
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
        "client_id=wildflower-host&scope=system%2F*.cruds",
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

    // The minted family records the authorization-code grant that authorized it
    // — write-only plumbing for a future per-device revoke. This is the
    // code-flow half of the "family carries grant_id for both flows" contract.
    {
        let store = store_handle(&db);
        let grant = store
            .grant_by_client_and_redirect(
                "test-app",
                &Url::parse("https://app.example/cb").unwrap(),
            )
            .expect("grant query")
            .expect("code grant minted at approval");
        let (_, family) = store
            .refresh_token_with_family_by_hash(&token_storage_hash(&first_refresh))
            .expect("family query")
            .expect("family present");
        assert_eq!(family.grant_id.as_deref(), Some(grant.id.as_str()));
    }

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
    let (row, _family) = store
        .refresh_token_with_family_by_hash(&token_storage_hash("stale-token"))
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
    let (row, _family) = store
        .refresh_token_with_family_by_hash(&token_storage_hash("owned-token"))
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
fn spin_up_with_confidential_client() -> (Gatekeeper, TestDb) {
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

// ---------------------------------------------------------------------------
// Cookie-based web-session auth (#218): the device-code / refresh grants set
// the `wf_auth` (HttpOnly JWT) + `wf_auth_exp` (readable hint) cookies, the auth
// middleware accepts a cookie-sourced token identically to a header-sourced one,
// and `POST /access/logout` clears them.
// ---------------------------------------------------------------------------

/// Collect every `Set-Cookie` value off a response, in order.
fn set_cookie_values(res: &axum::response::Response) -> Vec<String> {
    res.headers()
        .get_all(axum::http::header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().expect("ascii Set-Cookie").to_string())
        .collect()
}

/// The owner web-login path — a device-code grant — plants both session
/// cookies: the `HttpOnly` `wf_auth` carrying the very JWT returned in the body,
/// and the readable `wf_auth_exp` hint. `Max-Age` is the 15m `ACCESS_TOKEN_TTL`.
/// The test origin is http loopback (`LOOPBACK_ORIGIN`), so `Secure` is omitted
/// — the direct-loopback web path Safari must be able to store (issue #218).
#[tokio::test]
async fn device_grant_sets_session_cookies() {
    let (g, _host_owner_token, db) = spin_up();
    plant_device_request(
        &store_handle(&db),
        "wildflower-host",
        "dev-cookie",
        &[&WILDFLOWER_LOCAL_GRANTED_SCOPES[0].to_string()],
        RequestStatus::Approved,
        Utc::now() + Duration::minutes(5),
    );
    let res = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&\
         client_id=wildflower-host&device_code=dev-cookie",
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let cookies = set_cookie_values(&res);
    let token = body_json(res.into_body()).await;
    let access_token = token["access_token"].as_str().expect("access_token");

    // The HttpOnly cookie carries the exact JWT from the body with the full
    // attribute set and the 15m TTL, and NO `Secure` over http loopback.
    let auth_cookie = cookies
        .iter()
        .find(|c| c.starts_with(&format!("wf_auth={access_token};")))
        .expect("wf_auth cookie present");
    assert!(auth_cookie.contains("HttpOnly"), "wf_auth must be HttpOnly");
    assert!(auth_cookie.contains("SameSite=Lax") && auth_cookie.contains("Path=/"));
    assert!(auth_cookie.contains("Max-Age=900"));
    assert!(
        !auth_cookie.contains("Secure"),
        "http loopback must omit Secure: {auth_cookie}"
    );
    // The companion is present, readable (never HttpOnly), and shares the TTL.
    let exp_cookie = cookies
        .iter()
        .find(|c| c.starts_with("wf_auth_exp="))
        .expect("wf_auth_exp cookie present");
    assert!(
        !exp_cookie.contains("HttpOnly"),
        "companion must stay readable"
    );
    assert!(exp_cookie.contains("Max-Age=900"));
}

/// The authorization-code grant is a third-party SMART app redeeming a code —
/// it must NOT plant an owner-origin session cookie (the security decision in
/// #218). Only the JSON token comes back.
#[tokio::test]
async fn authorization_code_grant_does_not_set_session_cookie() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    plant_authorization_code(
        &store_handle(&db),
        "test-app",
        &Url::parse("https://app.example/cb").unwrap(),
        &["read"],
        "cookieless-code",
        Utc::now() + Duration::minutes(1),
    );
    let res = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=authorization_code&client_id=test-app&code=cookieless-code&\
         code_verifier=verifierverifierverifierverifierverifierabc&\
         redirect_uri=https%3A%2F%2Fapp.example%2Fcb",
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert!(
        set_cookie_values(&res).is_empty(),
        "auth-code grant must not set a session cookie"
    );
}

/// The owner SPA refreshing its own session — a `refresh_token` grant by the
/// first-party `wildflower-host` client — re-plants both session cookies (the
/// second of the two owner-session grants in #218).
#[tokio::test]
async fn first_party_refresh_grant_sets_session_cookie() {
    let (g, _host_owner_token, db) = spin_up();
    // `wildflower-host` is seeded by `spin_up` (allows every grant), so only its
    // refresh-token family needs planting.
    plant_refresh_token(
        &store_handle(&db),
        "owner-refresh",
        "wildflower-host",
        Utc::now() + Duration::days(30),
    );
    let res = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&client_id=wildflower-host&refresh_token=owner-refresh",
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let cookies = set_cookie_values(&res);
    assert!(
        cookies.iter().any(|c| c.starts_with("wf_auth=")),
        "first-party refresh must re-plant wf_auth: {cookies:?}"
    );
    assert!(cookies.iter().any(|c| c.starts_with("wf_auth_exp=")));
}

/// A third-party SMART app also redeems `refresh_token` grants, but its grant
/// must NOT plant the owner-origin session cookie: doing so would overwrite the
/// owner's `wf_auth` with the app's lower-scoped token — a session-fixation /
/// forced-downgrade vector. Cookie-planting is keyed on the *resolved* grant's
/// client (`FIRST_PARTY_CLIENT_ID`), not the wire `grant_type`, so a third-party
/// refresh returns only the JSON token. See #218.
#[tokio::test]
async fn third_party_refresh_grant_does_not_set_session_cookie() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "test-app",
        "https://app.example/cb",
        &["read", "offline_access"],
    );
    plant_refresh_token(
        &store_handle(&db),
        "app-refresh",
        "test-app",
        Utc::now() + Duration::days(30),
    );
    let res = post_form(
        &g.router,
        "/oauth/token",
        "grant_type=refresh_token&client_id=test-app&refresh_token=app-refresh",
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert!(
        set_cookie_values(&res).is_empty(),
        "third-party refresh must not set a session cookie"
    );
}

/// An owner-gated route authenticates the *same* owner token whether it arrives
/// in the `Authorization` header or the `wf_auth` cookie — the middleware
/// verifies a token string regardless of source (#218).
#[tokio::test]
async fn owner_route_accepts_cookie_sourced_token_like_a_header() {
    let (g, host_owner_token, _db) = spin_up();

    let header_res = g
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
    assert_eq!(header_res.status(), StatusCode::OK);

    let cookie_res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get("/access/grants")
                .header("host", "127.0.0.1")
                .header("cookie", format!("wf_auth={host_owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(cookie_res.status(), StatusCode::OK);
}

/// Precedence: when a bearer header is present it is used as-is — there is no
/// fall-through to the cookie. A garbage bearer alongside a valid cookie is a
/// 401, locking the "bearer present wins" rule (#218 point 2).
#[tokio::test]
async fn bearer_header_takes_precedence_over_cookie() {
    let (g, host_owner_token, _db) = spin_up();
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get("/access/grants")
                .header("host", "127.0.0.1")
                .header("authorization", "Bearer not-a-real-token")
                .header("cookie", format!("wf_auth={host_owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

/// `POST /access/logout` is owner-gated (the cookie-sourced token satisfies the
/// gate), clears both session cookies with `Max-Age=0`, and redirects to `/`.
#[tokio::test]
async fn logout_clears_session_cookies() {
    let (g, host_owner_token, _db) = spin_up();
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::post("/access/logout")
                .header("host", "127.0.0.1")
                .header("cookie", format!("wf_auth={host_owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    // 303 downgrades the POST to a GET of `/`; the clearing cookies ride along.
    assert_eq!(res.status(), StatusCode::SEE_OTHER);
    assert_eq!(
        res.headers()
            .get(axum::http::header::LOCATION)
            .and_then(|v| v.to_str().ok()),
        Some("/"),
        "logout must redirect home"
    );
    let cookies = set_cookie_values(&res);
    assert!(
        cookies
            .iter()
            .any(|c| c.starts_with("wf_auth=;") && c.contains("Max-Age=0")),
        "logout must clear wf_auth: {cookies:?}"
    );
    assert!(
        cookies
            .iter()
            .any(|c| c.starts_with("wf_auth_exp=;") && c.contains("Max-Age=0")),
        "logout must clear wf_auth_exp: {cookies:?}"
    );
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
fn revocation_store_handle(db: &TestDb) -> token_revocation_rust::RevocationStore {
    token_revocation_rust::RevocationStore::new(db.revocation_conn.clone())
        .expect("revocation store handle")
}

/// Pull the `jti` out of a minted token's payload (the base64url middle
/// segment). Uses gatekeeper's own base64 helper — the bare `base64` name is
/// shadowed in this file by the `crypto_util::base64` module import at the top.
fn jti_of(token: &str) -> String {
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
fn owner_grants_probe(token: &str) -> Request<Body> {
    loopback_request(
        Request::get("/access/grants")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {token}")),
        Body::empty(),
    )
}

#[tokio::test]
async fn gate_allows_a_live_token_across_repeated_requests() {
    // Regression guard for the reframe: the same multi-use bearer must
    // authenticate again and again — revocation must NOT reintroduce single-use.
    let (g, host_owner_token, _db) = spin_up();
    for _ in 0..3 {
        let res = g
            .router
            .clone()
            .oneshot(owner_grants_probe(&host_owner_token))
            .await
            .expect("oneshot");
        assert_eq!(
            res.status(),
            StatusCode::OK,
            "a live token must keep passing"
        );
    }
}

#[tokio::test]
async fn gate_rejects_a_revoked_jti() {
    let (g, host_owner_token, db) = spin_up();
    // Live first.
    let res = g
        .router
        .clone()
        .oneshot(owner_grants_probe(&host_owner_token))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    // Denylist this token's jti; the same token is now rejected.
    let jti = jti_of(&host_owner_token);
    revocation_store_handle(&db)
        .revoke_jti(&jti, Utc::now() + Duration::hours(1), "test")
        .expect("revoke");
    let res = g
        .router
        .clone()
        .oneshot(owner_grants_probe(&host_owner_token))
        .await
        .expect("oneshot");
    assert_eq!(
        res.status(),
        StatusCode::UNAUTHORIZED,
        "a revoked jti must be rejected by the gate"
    );
}

#[tokio::test]
async fn gate_rejects_after_subject_epoch_bump() {
    let (g, host_owner_token, db) = spin_up();
    // Bulk-revoke the host client's cohort. JWT `iat` is second-precision, so
    // advance the epoch one second past the mint second to unambiguously cover a
    // token minted moments ago in this test.
    revocation_store_handle(&db)
        .bump_subject_epoch("wildflower-host", Utc::now() + Duration::seconds(1))
        .expect("bump");
    let res = g
        .router
        .clone()
        .oneshot(owner_grants_probe(&host_owner_token))
        .await
        .expect("oneshot");
    assert_eq!(
        res.status(),
        StatusCode::UNAUTHORIZED,
        "an epoch bump must revoke pre-epoch tokens"
    );
}

#[tokio::test]
async fn logout_revokes_the_presented_jti() {
    let (g, host_owner_token, db) = spin_up();
    let jti = jti_of(&host_owner_token);
    // Log out, presenting the token as the `wf_auth` cookie (the web path).
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::post("/access/logout")
                .header("host", "127.0.0.1")
                .header("cookie", format!("wf_auth={host_owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::SEE_OTHER);
    // The presented token's jti is now denylisted...
    assert!(
        revocation_store_handle(&db)
            .is_revoked_by_jti(&jti)
            .expect("query"),
        "logout must denylist the presented token's jti"
    );
    // ...and the same token no longer authenticates.
    let res = g
        .router
        .clone()
        .oneshot(owner_grants_probe(&host_owner_token))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

/// Build an owner-authenticated `POST /access/revocations` with a JSON body.
fn owner_revocation_request(token: &str, body: Value) -> Request<Body> {
    loopback_request(
        Request::post("/access/revocations")
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json"),
        Body::from(body.to_string()),
    )
}

#[tokio::test]
async fn revocations_endpoint_revokes_by_jti() {
    let (g, host_owner_token, _db) = spin_up();
    let jti = jti_of(&host_owner_token);
    let res = g
        .router
        .clone()
        .oneshot(owner_revocation_request(
            &host_owner_token,
            serde_json::json!({
                "jti": jti,
                "expiresAt": (Utc::now() + Duration::hours(1)).to_rfc3339(),
            }),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    // The token it just revoked (its own) no longer authenticates.
    let res = g
        .router
        .clone()
        .oneshot(owner_grants_probe(&host_owner_token))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn revocations_endpoint_bulk_revokes_by_subject() {
    let (g, host_owner_token, db) = spin_up();
    let res = g
        .router
        .clone()
        .oneshot(owner_revocation_request(
            &host_owner_token,
            serde_json::json!({ "subject": "some-client" }),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    // The subject's epoch was bumped to ~now: a token that subject holds issued
    // an hour ago is revoked (checked directly, deterministically).
    assert!(
        revocation_store_handle(&db)
            .is_revoked(None, Some(Utc::now() - Duration::hours(1)), "some-client")
            .expect("query"),
        "subject-mode revoke must bump the subject epoch"
    );
}

#[tokio::test]
async fn revocations_endpoint_rejects_invalid_bodies() {
    let (g, host_owner_token, _db) = spin_up();
    let bad_bodies = [
        // jti without the required expiresAt
        serde_json::json!({ "jti": "abc" }),
        // both modes at once
        serde_json::json!({ "jti": "abc", "expiresAt": Utc::now().to_rfc3339(), "subject": "c" }),
        // neither mode
        serde_json::json!({}),
        // jti with an expiresAt already in the past (stale/mistyped)
        serde_json::json!({
            "jti": "abc",
            "expiresAt": (Utc::now() - Duration::hours(1)).to_rfc3339(),
        }),
    ];
    for body in bad_bodies {
        let res = g
            .router
            .clone()
            .oneshot(owner_revocation_request(&host_owner_token, body.clone()))
            .await
            .expect("oneshot");
        assert_eq!(
            res.status(),
            StatusCode::BAD_REQUEST,
            "invalid revocation body must 400: {body}"
        );
    }
}

#[tokio::test]
async fn revocations_endpoint_requires_owner_auth() {
    let (g, _host_owner_token, _db) = spin_up();
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::post("/access/revocations")
                .header("host", "127.0.0.1")
                .header("content-type", "application/json"),
            Body::from(serde_json::json!({ "subject": "c" }).to_string()),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn revoking_a_grant_bumps_the_client_revocation_epoch() {
    let (g, host_owner_token, db) = spin_up();
    // Seed a client + a grant for it.
    seed_client_with_redirect(&db, "granted-client", "https://app.example/cb", &["read"]);
    let store = store_handle(&db);
    store
        .create_authorization_code_grant(&gatekeeper_rust::domain::grant::AuthorizationCodeGrant {
            id: "grant-1".to_string(),
            client_id: "granted-client".to_string(),
            scopes: vec!["read".to_string()],
            granted_at: Utc::now(),
            last_used_at: None,
            patient: None,
            redirect_uri: Url::parse("https://app.example/cb").expect("url"),
        })
        .expect("create grant");
    // Revoke it.
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::delete("/access/grants/grant-1")
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {host_owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    // The client's live access tokens are now revoked via the epoch — a token
    // it holds issued an hour ago reads back revoked.
    assert!(
        revocation_store_handle(&db)
            .is_revoked(
                None,
                Some(Utc::now() - Duration::hours(1)),
                "granted-client"
            )
            .expect("query"),
        "grant revoke must bump the client's revocation epoch"
    );
}

#[tokio::test]
async fn revoking_a_device_grant_bumps_the_client_revocation_epoch() {
    // Integration point with the polymorphic device grants (#332): the
    // Authorized Devices list revokes a device through the same
    // `DELETE /access/grants/{id}` surface, so token revocation must fire for a
    // `DeviceCode` grant exactly as it does for an authorization-code one. This
    // is the token-revocation half of "revoke this device" — the access-token
    // epoch is keyed on `sub = client_id`, so revoking one device grant revokes
    // that client's live access tokens (per-device token handles are deferred —
    // see #269).
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "device-client", "https://app.example/cb", &["read"]);
    let store = store_handle(&db);
    store
        .create_device_grant(&gatekeeper_rust::domain::grant::DeviceGrant {
            id: "device-grant-1".to_string(),
            client_id: "device-client".to_string(),
            scopes: vec!["read".to_string()],
            granted_at: Utc::now(),
            last_used_at: None,
            patient: None,
            device_name: "Ada's laptop".to_string(),
        })
        .expect("create device grant");
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::delete("/access/grants/device-grant-1")
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {host_owner_token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    assert!(
        revocation_store_handle(&db)
            .is_revoked(None, Some(Utc::now() - Duration::hours(1)), "device-client")
            .expect("query"),
        "revoking a device grant must bump the client's revocation epoch"
    );
}
