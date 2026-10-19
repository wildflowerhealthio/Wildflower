//! [`TestAuthorizationServer`]: a server's authorization server over a temporary database, for
//! the commands' tests to mint through.

use std::sync::Arc;

use tokio::sync::watch;
use url::Url;
use wildflowerhealthio_authorization_server::domain::grant_store::AuthorizationRequestsTx as _;
use wildflowerhealthio_authorization_server::domain::authorization_request::{
    AuthorizationRequest, CodeRequest, NewAuthorizationRequest, RequestKind,
};
use wildflowerhealthio_authorization_server::{
    setup_authorization_server, AdmitEveryAuthorizationStart, AuthorizationServerConfig,
    GrantStore, LaunchContextMinter, NewestPendingConsent, PendingConsentWatcher,
    SameDeviceSignInCodeMinter, SqliteGrantStore,
};
use wildflowerhealthio_shared_structures::authorization_app::AuthorizationAppBase;
use wildflowerhealthio_shared_structures::launcher::LauncherBase;

/// The domain of the server the authorization server is for.
pub(crate) const DOMAIN: &str = "ruth.relay.example.com";

/// An authorization server over a temporary database, the way a server's run sets one
/// up, with what the test reads it through.
pub(crate) struct TestAuthorizationServer {
    pub(crate) launch_context_minter: LaunchContextMinter,
    pub(crate) same_device_sign_in_code_minter: SameDeviceSignInCodeMinter,
    pub(crate) pending_consent_watcher: PendingConsentWatcher,
    _pending_consent_rx: watch::Receiver<Option<NewestPendingConsent>>,
    database_dir: tempfile::TempDir,
}

impl TestAuthorizationServer {
    /// How many launches the authorization server has minted.
    pub(crate) fn minted_launches(&self) -> i64 {
        wildflowerhealthio_persistence::Connection::open(
            &self.database_dir.path().join(DATABASE_FILE),
        )
        .unwrap()
        .lock()
        .query_row("SELECT COUNT(*) FROM launch_contexts", [], |row| row.get(0))
        .unwrap()
    }

    /// Park an app's authorization request under `id`, pending for five
    /// minutes, as `/oauth/authorize` would.
    pub(crate) fn park_consent(&self, id: &str) {
        let pool = wildflowerhealthio_persistence::open_pool(
            &self.database_dir.path().join(DATABASE_FILE),
        )
        .unwrap();
        SqliteGrantStore::new(pool)
            .unwrap()
            .write(|tx| {
                tx.insert_authorization_request(&AuthorizationRequest::new(
                    NewAuthorizationRequest {
                        id: id.to_owned(),
                        client_id: "lifting".to_owned(),
                        requested_scopes: vec!["openid".to_owned()],
                        ttl: chrono::Duration::minutes(5),
                        kind: RequestKind::AuthorizationCode(CodeRequest {
                            redirect_uri: Url::parse("https://lifting.example/callback").unwrap(),
                            code_challenge: "c".repeat(43),
                            client_state: "state".to_owned(),
                            sid: "requesting-browser".to_owned(),
                            launch: None,
                            launch_bound_patient: None,
                            pre_approved_scopes: Vec::new(),
                            decidable_in_requesting_browser: false,
                            session_shortfall_acknowledged: true,
                        }),
                    },
                    chrono::Utc::now(),
                ))
            })
            .unwrap();
    }
}

/// The authorization server's database in its temporary folder.
const DATABASE_FILE: &str = "wildflower.sqlite";

pub(crate) fn test_authorization_server() -> TestAuthorizationServer {
    let database_dir = tempfile::tempdir().unwrap();
    let pool = wildflowerhealthio_persistence::open_pool(&database_dir.path().join(DATABASE_FILE))
        .unwrap();
    let revocation_store = wildflowerhealthio_token_revocation::RevocationStore::new(
        wildflowerhealthio_persistence::Connection::open_in_memory().unwrap(),
    )
    .unwrap();
    let (pending_consent_tx, pending_consent_rx) = watch::channel(None);
    let authorization_server = setup_authorization_server(
        pool,
        revocation_store,
        &AuthorizationServerConfig {
            server_origin: Url::parse(&format!("https://{DOMAIN}")).unwrap(),
            host_app_client_scopes:
                wildflowerhealthio_authorization_server::default_host_app_client_scopes(),
            wildflower_host_app_client_id:
                wildflowerhealthio_authorization_server::default_wildflower_host_app_client_id(),
            fhir_ui_client_id: "fhir-ui-client".to_string(),
            launcher_base: LauncherBase::parse("https://launcher.test/launcher/").unwrap(),
            authorization_app_base: AuthorizationAppBase::parse(
                "https://authorization.test/authorization/",
            )
            .unwrap(),
            launcher_url: Url::parse("https://launcher.test/launcher/").unwrap(),
            authorization_url: Url::parse("https://authorization.test/authorization/").unwrap(),
        },
        pending_consent_tx,
        Arc::new(AdmitEveryAuthorizationStart),
    )
    .unwrap();
    TestAuthorizationServer {
        launch_context_minter: authorization_server.launch_context_minter,
        same_device_sign_in_code_minter: authorization_server.same_device_sign_in_code_minter,
        pending_consent_watcher: authorization_server.pending_consent_watcher,
        _pending_consent_rx: pending_consent_rx,
        database_dir,
    }
}
