//! [`TestGatekeeper`]: a server's gatekeeper over a temporary database, for
//! the commands' tests to read, decide and mint through.

use std::sync::Arc;

use tokio::sync::watch;
use url::Url;
use wildflowerhealthio_gatekeeper::{
    setup_gatekeeper, GatekeeperConfig, HostConsentDecider, LaunchContextMinter,
    NoLoopbackConsentPrompt, PendingConsentHead, SqliteGatekeeperStore,
};
use wildflowerhealthio_shared_structures::launcher::LauncherBase;

/// The domain of the server the gatekeeper is for.
pub(crate) const DOMAIN: &str = "ruth.relay.example.com";

/// A gatekeeper over a temporary database, the way a server's run sets one
/// up, with what the test reads it through.
pub(crate) struct TestGatekeeper {
    pub(crate) consent_decider: HostConsentDecider,
    pub(crate) launch_context_minter: LaunchContextMinter,
    pub(crate) store: SqliteGatekeeperStore,
    _pending_consent_rx: watch::Receiver<Option<PendingConsentHead>>,
    _owner_token_rx: watch::Receiver<Option<String>>,
    database_dir: tempfile::TempDir,
}

impl TestGatekeeper {
    /// How many launches the gatekeeper has minted.
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

/// The gatekeeper's database in its temporary folder.
const DATABASE_FILE: &str = "wildflower.sqlite";

pub(crate) fn test_gatekeeper() -> TestGatekeeper {
    let database_dir = tempfile::tempdir().unwrap();
    let pool = wildflowerhealthio_persistence::open_pool(&database_dir.path().join(DATABASE_FILE))
        .unwrap();
    let revocation_store = wildflowerhealthio_token_revocation::RevocationStore::new(
        wildflowerhealthio_persistence::Connection::open_in_memory().unwrap(),
    )
    .unwrap();
    let (owner_token_tx, owner_token_rx) = watch::channel(None);
    let (pending_consent_tx, pending_consent_rx) = watch::channel(None);
    let gatekeeper = setup_gatekeeper(
        pool.clone(),
        revocation_store,
        &GatekeeperConfig {
            loopback_base_url: Url::parse("http://127.0.0.1:8080/").unwrap(),
            server_origin: Url::parse(&format!("https://{DOMAIN}")).unwrap(),
            host_owner_scopes: wildflowerhealthio_gatekeeper::default_local_granted_scopes(),
            first_party_client_id: wildflowerhealthio_gatekeeper::default_first_party_client_id(),
            launcher_base: LauncherBase::parse("https://launcher.test/launcher/").unwrap(),
        },
        &owner_token_tx,
        pending_consent_tx,
        Arc::new(NoLoopbackConsentPrompt),
    )
    .unwrap();
    TestGatekeeper {
        consent_decider: HostConsentDecider::new(gatekeeper.state),
        launch_context_minter: gatekeeper.launch_context_minter,
        store: SqliteGatekeeperStore::new(pool).unwrap(),
        _pending_consent_rx: pending_consent_rx,
        _owner_token_rx: owner_token_rx,
        database_dir,
    }
}
