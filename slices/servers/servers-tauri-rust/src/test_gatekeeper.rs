//! [`TestGatekeeper`]: a server's gatekeeper over a temporary database, for
//! the commands' tests to read, decide and mint through.

use std::sync::Arc;

use gatekeeper_rust::{
    setup_gatekeeper, GatekeeperConfig, HostConsentDecider, LaunchContextMinter,
    NoLoopbackConsentPrompt, PendingConsentHead, SqliteGatekeeperStore,
};
use shared_structures_rust::owner_ui::OwnerUiBase;
use tokio::sync::watch;
use url::Url;

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
    _database_dir: tempfile::TempDir,
}

pub(crate) fn test_gatekeeper() -> TestGatekeeper {
    let database_dir = tempfile::tempdir().unwrap();
    let pool = persistence_rust::open_pool(&database_dir.path().join("wildflower.sqlite")).unwrap();
    let revocation_store = token_revocation_rust::RevocationStore::new(
        persistence_rust::Connection::open_in_memory().unwrap(),
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
            host_owner_scopes: gatekeeper_rust::default_local_granted_scopes(),
            first_party_client_id: gatekeeper_rust::default_first_party_client_id(),
            owner_ui_base: OwnerUiBase::parse("https://owner-ui.test/app/").unwrap(),
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
        _database_dir: database_dir,
    }
}
