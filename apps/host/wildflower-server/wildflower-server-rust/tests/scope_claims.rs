//! The seam between two server slices the server composes: databases'
//! per-database scope gate only works because the authorization server's bearer gate inserts
//! a `ScopeClaims` into the request's extensions. This drives the real producer
//! (the gate) and the real consumer (databases' `Scoped<DatabasesReader>`)
//! together. If the gate ever stopped inserting `ScopeClaims`, every gated
//! `/databases` request would 500 instead of 200 or 403, and only this test
//! would catch it: each slice's own tests fabricate the extension.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tokio::sync::watch;
use tower::ServiceExt;
use url::Url;
use wildflowerhealthio_authorization_server::domain::token::{mint_access_token, NewJwtArgs};
use wildflowerhealthio_authorization_server::{
    authorization_server_auth_middleware, setup_authorization_server, AuthorizationServerConfig,
    GrantStore, NewestPendingConsent, SqliteGrantStore,
};
use wildflowerhealthio_persistence::{Connection, DieselPool};
use wildflowerhealthio_shared_structures::authorization_app::AuthorizationAppBase;
use wildflowerhealthio_shared_structures::launcher::LauncherBase;

/// The server's origin: the `iss` and `aud` of every token its authorization server
/// mints, and the only ones its bearer gate accepts.
const SERVER_ORIGIN: &str = "https://test.relay.invalid";

/// An authorization server over an in-memory database.
fn set_up_authorization_server(
    pool: &DieselPool,
) -> wildflowerhealthio_authorization_server::AuthorizationServer {
    let config = AuthorizationServerConfig {
        server_origin: Url::parse(SERVER_ORIGIN).expect("server origin URL"),
        host_app_client_scopes:
            wildflowerhealthio_authorization_server::default_host_app_client_scopes(),
        wildflower_host_app_client_id:
            wildflowerhealthio_authorization_server::default_wildflower_host_app_client_id(),
        fhir_ui_client_id: "fhir-ui-client".to_string(),
        launcher_base: LauncherBase::parse("https://launcher.test/launcher/")
            .expect("launcher base URL"),
        authorization_app_base: AuthorizationAppBase::parse(
            "https://authorization.test/authorization/",
        )
        .expect("authorization app base URL"),
        launcher_url: Url::parse("https://launcher.test/launcher/").expect("launcher URL"),
        authorization_url: Url::parse("https://authorization.test/authorization/")
            .expect("authorization URL"),
    };
    let (pending_consent_tx, _pending_consent_rx) =
        watch::channel::<Option<NewestPendingConsent>>(None);
    let revocation_store = wildflowerhealthio_token_revocation::RevocationStore::new(
        Connection::open_in_memory().expect("open revocation db"),
    )
    .expect("revocation store");
    setup_authorization_server(pool.clone(), revocation_store, &config, pending_consent_tx)
        .expect("set up the authorization server")
}

/// A token carrying exactly `scopes`, signed by the authorization server's
/// active key and naming [`SERVER_ORIGIN`] as `iss` and `aud`.
fn mint_scoped_token(pool: &DieselPool, scopes: &[&str]) -> String {
    let key = SqliteGrantStore::new(pool.clone())
        .expect("store handle")
        .active_signing_key()
        .expect("signing-key query")
        .expect("a seeded active signing key");
    let scopes: Vec<String> = scopes.iter().map(|s| (*s).to_owned()).collect();
    mint_access_token(
        &key,
        &NewJwtArgs {
            client_id: "scoped-app",
            scopes: &scopes,
            ttl: chrono::Duration::seconds(300),
            issuer: SERVER_ORIGIN,
            audience: Some(SERVER_ORIGIN),
            patient: None,
        },
    )
    .expect("mint token")
}

#[tokio::test]
async fn bearer_gate_inserts_scope_claims_a_databases_capability_reads() {
    let pool = wildflowerhealthio_persistence::open_in_memory_pool().expect("open in-memory pool");
    let authorization_server = set_up_authorization_server(&pool);
    let owner_token = mint_scoped_token(&pool, &["system/*.cruds", "wildflower/*.cruds"]);

    // A one-database catalogue gated by `wildflower/*` read/delete, backed by a
    // real on-disk SQLite file so the metadata read and snapshot have something
    // to work against.
    let data_dir = tempfile::tempdir().expect("tempdir");
    let db_id = "wildflower.sqlite";
    Connection::open(&data_dir.path().join(db_id))
        .expect("seed db")
        .lock()
        .execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY);")
        .expect("seed table");
    let config = wildflowerhealthio_databases::DatabasesConfig {
        data_dir: data_dir.path().to_path_buf(),
        databases: vec![wildflowerhealthio_databases::DatabaseDescriptor {
            id: db_id.to_owned(),
            label: "Wildflower app data".to_owned(),
            description: "App state.".to_owned(),
            read_scope: wildflowerhealthio_scopes::Scope::wildflower_all(
                wildflowerhealthio_scopes::Permission::READ,
            ),
            delete_scope: wildflowerhealthio_scopes::Scope::wildflower_all(
                wildflowerhealthio_scopes::Permission::DELETE,
            ),
        }],
    };
    let gated = wildflowerhealthio_databases::setup_databases(&config).layer(
        authorization_server_auth_middleware(authorization_server.state.clone(), &[]),
    );

    let get_status = |token: Option<String>| {
        let gated = gated.clone();
        async move {
            let mut builder = Request::get(format!("/databases/{db_id}"));
            if let Some(token) = token {
                builder = builder.header("authorization", format!("Bearer {token}"));
            }
            let request = builder.body(Body::empty()).expect("build request");
            gated.oneshot(request).await.expect("oneshot").status()
        }
    };

    // No token: 401 at the gate, before any capability runs.
    assert_eq!(get_status(None).await, StatusCode::UNAUTHORIZED);
    // The owner token covers `wildflower/*`, so the capability builds and
    // streams the snapshot: the gate inserted a `ScopeClaims` it could read.
    assert_eq!(get_status(Some(owner_token)).await, StatusCode::OK);
    // A valid token that doesn't cover the database's read scope: 403 from the
    // capability, not a 500. It read the inserted claims and found them
    // insufficient.
    let under_scoped = mint_scoped_token(&pool, &["system/Observation.r"]);
    assert_eq!(get_status(Some(under_scoped)).await, StatusCode::FORBIDDEN);
}
