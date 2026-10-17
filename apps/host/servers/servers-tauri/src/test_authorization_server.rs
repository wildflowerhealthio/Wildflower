//! [`TestAuthorizationServer`]: a server's authorization server over a temporary database, for
//! the commands' tests to mint through.

use std::sync::Arc;

use tokio::sync::watch;
use url::Url;
use wildflowerhealthio_authorization_server::domain::authorization_request::{
    AuthorizationRequest, RequestStatus, StartCodeAuthorizationArgs,
};
use wildflowerhealthio_authorization_server::{
    setup_authorization_server, AdmitEveryAuthorizationStart, AuthorizationServerConfig,
    GrantStore, LaunchContextMinter, NewestPendingConsent, PendingConsentDenier,
    PendingConsentWatcher, SameDeviceSignInCodeMinter, SqliteGrantStore,
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
    pub(crate) pending_consent_denier: PendingConsentDenier,
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
        self.park_decided_consent(id, RequestStatus::Pending);
    }

    /// Park an app's authorization request under `id`, as
    /// [`park_consent`](Self::park_consent) does, already `status`.
    pub(crate) fn park_decided_consent(&self, id: &str, status: RequestStatus) {
        let mut request =
            AuthorizationRequest::new_code_authorization(StartCodeAuthorizationArgs {
                id: id.to_owned(),
                client_id: "lifting".to_owned(),
                requested_scopes: vec!["openid".to_owned()],
                code_challenge: "c".repeat(43),
                redirect_uri: Url::parse("https://lifting.example/callback").unwrap(),
                client_state: "state".to_owned(),
                pre_approved_scopes: Vec::new(),
                ttl: chrono::Duration::minutes(5),
                launch_context: None,
                decidable_in_requesting_browser: false,
                sid: None,
            });
        request.status = status;
        self.store().insert_authorization_request(&request).unwrap();
    }

    /// The status of the authorization request `id`.
    pub(crate) fn consent_status(&self, id: &str) -> RequestStatus {
        self.store()
            .authorization_request_by_id(id)
            .unwrap()
            .unwrap()
            .status
    }

    /// A store over the authorization server's database.
    fn store(&self) -> SqliteGrantStore {
        let pool = wildflowerhealthio_persistence::open_pool(
            &self.database_dir.path().join(DATABASE_FILE),
        )
        .unwrap();
        SqliteGrantStore::new(pool).unwrap()
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
        pending_consent_denier: authorization_server.pending_consent_denier,
        _pending_consent_rx: pending_consent_rx,
        database_dir,
    }
}
