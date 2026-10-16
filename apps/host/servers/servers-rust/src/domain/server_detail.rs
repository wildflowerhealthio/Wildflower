//! [`ServerDetail`], what a server's run reports to `UnitRunner` beyond its
//! run state, and [`ServerRunId`], the run that reports it.

use std::sync::atomic::{AtomicU64, Ordering};

use wildflowerhealthio_authorization_server::NewestPendingConsent;
use wildflowerhealthio_tunnel::TunnelState;
use wildflowerhealthio_wildflower_server::{CertificateState, ServerHealth};

use crate::live_bindings::server_consent_watcher::ServerConsentWatcher;
use crate::live_bindings::server_launch_minter::ServerLaunchMinter;
use crate::live_bindings::server_sign_in_code_minter::ServerSignInCodeMinter;

/// A server's own status: `UnitRunner`'s `Detail` for a
/// [`ServerUnit`](crate::ServerUnit). `UnitRunner` reports it in the server's
/// `UnitStatus` while a run is in progress, and clears it when the run ends.
/// A run reports it once the server is set up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerDetail {
    /// The run that reports this detail, the same in every detail a run
    /// sets, so a report from a run the host started again tells from one
    /// its earlier run left in the status.
    pub run: ServerRunId,
    /// Whether the server's `/health` has answered through its public origin
    /// (the relay and the tunnel), as the server's reachability monitor
    /// publishes it; `None` until its first probe.
    pub health: Option<ServerHealth>,
    /// Where the server's tunnel's connection to its relay stands, as its
    /// tunnel daemon publishes it for as long as the run lasts; `None` until
    /// the daemon starts.
    pub tunnel: Option<TunnelState>,
    /// Where the server's certificate stands, as the run publishes it while
    /// it deploys, orders and renews it; `None` until the run's certificate
    /// starts.
    pub certificate: Option<CertificateState>,
    /// The newest consent waiting for the Owner's answer on this server, as
    /// its authorization server publishes it; `None` when nothing waits.
    pub pending_consent: Option<NewestPendingConsent>,
    /// How the host mints the launches it opens this server's launcher with.
    /// A run always sets it; it is `None` only in a detail built without a
    /// server, as the domain's tests build theirs.
    pub launch_minter: Option<ServerLaunchMinter>,
    /// How the host mints the codes it signs the in-app browser in as the
    /// Owner with, before it opens a launch or the Authorization app there.
    /// A run always sets it; it is `None` only in a detail built without a
    /// server, as the domain's tests build theirs.
    pub sign_in_code_minter: Option<ServerSignInCodeMinter>,
    /// How the host waits for a consent it opened on this server to be
    /// decided or expire, to close the page it opened it at. A run always
    /// sets it; it is `None` only in a detail built without a server, as the
    /// domain's tests build theirs.
    pub consent_watcher: Option<ServerConsentWatcher>,
}

/// One run of a server, among every run of any server since the app started:
/// no two runs have the same id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ServerRunId(u64);

impl ServerRunId {
    /// An id no earlier run had, for a run starting.
    #[must_use]
    pub fn next() -> Self {
        static RUNS_STARTED: AtomicU64 = AtomicU64::new(0);
        Self(RUNS_STARTED.fetch_add(1, Ordering::Relaxed))
    }
}
