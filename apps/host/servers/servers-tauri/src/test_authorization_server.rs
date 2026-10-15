//! [`TestAuthorizationServer`]: a server's authorization server over a temporary database, for
//! the commands' tests to read, decide and mint through.

use tokio::sync::watch;
use url::Url;
use wildflowerhealthio_authorization_server::{
    setup_authorization_server, AuthorizationServerConfig, HostConsentDecider, LaunchContextMinter,
    PendingConsentHead, SameDeviceSignInCodeMinter, SqliteGrantStore,
};
use wildflowerhealthio_shared_structures::authorization_app::AuthorizationAppBase;
use wildflowerhealthio_shared_structures::launcher::LauncherBase;

/// The domain of the server the authorization server is for.
pub(crate) const DOMAIN: &str = "ruth.relay.example.com";

/// An authorization server over a temporary database, the way a server's run sets one
/// up, with what the test reads it through.
pub(crate) struct TestAuthorizationServer {
    pub(crate) consent_decider: HostConsentDecider,
    pub(crate) launch_context_minter: LaunchContextMinter,
    pub(crate) same_device_sign_in_code_minter: SameDeviceSignInCodeMinter,
    pub(crate) store: SqliteGrantStore,
    _pending_consent_rx: watch::Receiver<Option<PendingConsentHead>>,
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
        pool.clone(),
        revocation_store,
        &AuthorizationServerConfig {
            loopback_base_url: Url::parse("http://127.0.0.1:8080/").unwrap(),
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
    )
    .unwrap();
    TestAuthorizationServer {
        consent_decider: HostConsentDecider::new(authorization_server.state),
        launch_context_minter: authorization_server.launch_context_minter,
        same_device_sign_in_code_minter: authorization_server.same_device_sign_in_code_minter,
        store: SqliteGrantStore::new(pool).unwrap(),
        _pending_consent_rx: pending_consent_rx,
        database_dir,
    }
}
