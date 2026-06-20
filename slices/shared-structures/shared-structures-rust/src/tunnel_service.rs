//! The tunnel service contract — the APIs the tunnel exposes to other slices.
//!
//! The tunnel slice (`tunnel-rust`) implements [`TunnelService`] and hands a
//! `dyn TunnelService` to the composition root, which threads it into the apps
//! slice. apps-rust depends only on this contract, never on tunnel-rust — both
//! sides meet here.
//!
//! Gated behind the `tunnel-service` cargo feature so the lean default build of
//! `shared-structures-rust` (and crates like `emr`/`gatekeeper` that don't touch
//! the tunnel) stays free of `tokio`/`async-trait`.

use tokio::sync::watch;

/// The liveness state of the tunnel. The full FSM lives in the tunnel slice;
/// this is the position consumers care about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TunnelStatus {
    /// Not requested on.
    Off,
    /// Requested on but un-dialable (no relay, or no public host).
    Misconfigured,
    /// Attempting; not yet proven reachable.
    Dialing,
    /// A `/health` probe through the public origin came back healthy — the only
    /// state in which the current origin is the public `https://{host}`.
    Verified,
    /// Was attempting, but the dial dropped or the probe failed; retrying.
    Unreachable,
}

impl TunnelStatus {
    /// Whether a supervisor is actively attempting to keep the tunnel up
    /// (`Dialing`/`Verified`/`Unreachable`), as opposed to idle/terminal
    /// (`Off`/`Misconfigured`).
    pub fn is_running(self) -> bool {
        matches!(
            self,
            TunnelStatus::Dialing | TunnelStatus::Verified | TunnelStatus::Unreachable
        )
    }
}

/// A snapshot of the live tunnel state, carried on [`TunnelService::subscribe`]
/// and read by the tunnel slice itself (it is the slice's one liveness type —
/// there is no separate internal struct).
///
/// Most consumers only care about `status`/`origin`/`error`;
/// `settings_revision` and `dial_attempts` are the optimistic-concurrency token
/// and the reconnect counter the tunnel slice carries for its own bookkeeping
/// (and surfaces on the `/tunnel` HTTP wire). They're part of the snapshot so
/// the slice's supersession guard stays serialized with state writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunnelLiveness {
    /// Which revision of the persisted tunnel *settings* this snapshot reflects
    /// — the optimistic-concurrency token bumped on each accepted settings
    /// write. `None` before the tunnel has reconciled any settings.
    pub settings_revision: Option<i64>,
    /// The liveness FSM position.
    pub status: TunnelStatus,
    /// The current most-available origin: the verified public origin while
    /// `Verified`, else the loopback fallback.
    pub origin: String,
    /// A human-readable reason for `Misconfigured`/`Unreachable`, else `None`.
    pub error: Option<String>,
    /// How many times the tunnel has tried to *dial* the relay for the current
    /// settings revision; resets to 0 when the revision changes. A climbing
    /// count with a steady `error` flags a permanent misconfiguration.
    pub dial_attempts: i64,
}

/// The APIs the tunnel provides to other slices. Object-safe so a host can hand
/// out `Arc<dyn TunnelService>`.
#[async_trait::async_trait]
pub trait TunnelService: Send + Sync {
    /// The current most-available origin — the verified public origin while the
    /// tunnel is up, else the loopback fallback. A cheap, synchronous read.
    fn current_origin(&self) -> String;

    /// Try to bring the tunnel up, returning the verified public origin once a
    /// reachability check confirms it, or a human-readable reason it couldn't.
    /// Idempotent: a no-op (beyond re-confirming) when already up.
    async fn try_start(&self) -> Result<String, String>;

    /// Subscribe to tunnel state changes. Consumers `borrow()` for the live
    /// value or `await changed()` for transitions.
    fn subscribe(&self) -> watch::Receiver<TunnelLiveness>;
}

/// A [`TunnelService`] that is never available: `try_start` always fails and the
/// state stays [`Off`](TunnelStatus::Off). For hosts wired without a tunnel and
/// for tests that don't exercise one.
pub struct OfflineTunnel {
    origin: String,
    state: watch::Sender<TunnelLiveness>,
}

impl OfflineTunnel {
    /// `origin` is what [`current_origin`](TunnelService::current_origin)
    /// reports — typically the host's loopback origin.
    pub fn new(origin: impl Into<String>) -> Self {
        let origin = origin.into();
        let (state, _) = watch::channel(TunnelLiveness {
            settings_revision: None,
            status: TunnelStatus::Off,
            origin: origin.clone(),
            error: None,
            dial_attempts: 0,
        });
        Self { origin, state }
    }
}

#[async_trait::async_trait]
impl TunnelService for OfflineTunnel {
    fn current_origin(&self) -> String {
        self.origin.clone()
    }

    async fn try_start(&self) -> Result<String, String> {
        Err("tunnel not available".to_string())
    }

    fn subscribe(&self) -> watch::Receiver<TunnelLiveness> {
        self.state.subscribe()
    }
}
