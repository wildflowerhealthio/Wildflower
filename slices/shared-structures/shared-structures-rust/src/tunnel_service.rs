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
///
/// This is also the type the tunnel slice's `/tunnel` HTTP surface serializes
/// directly (lowercase variants), so it derives `Serialize`/`ToSchema` here
/// rather than a parallel wire enum re-declaring the same five variants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
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
    /// The configured public host (bare, no scheme or port), normalized so an
    /// empty stored value reads as `None` — independent of the liveness
    /// `status`. Carried on the snapshot so a hot-path consumer (the host's
    /// subdomain reverse proxy) can read it `O(1)` off the watch instead of a
    /// locked SQLite read per forwarded request. See
    /// [`TunnelService::current_public_host`], which exposes the same value.
    pub public_host: Option<String>,
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

    /// The configured public host (bare, no scheme or port) the front
    /// advertises — independent of whether the tunnel is currently `Verified`.
    /// `None` when no public host is configured, in which case the tunnel
    /// cannot be brought up at all.
    ///
    /// Distinct from [`Self::current_origin`], which conflates "tunnel down"
    /// with "no public host configured": callers that need the public *name*
    /// itself (e.g. to match an inbound forwarded request's subdomain against
    /// the configured host) use this instead. Default returns `None` — only
    /// the live tunnel slice needs to override it.
    ///
    /// The same value also rides on every [`TunnelLiveness`] snapshot
    /// ([`TunnelLiveness::public_host`]); a hot-path consumer that already holds
    /// a [`Self::subscribe`] receiver reads it from there `O(1)` rather than
    /// paying this call's per-invocation cost (which, in the live slice, is a
    /// locked settings read).
    fn current_public_host(&self) -> Option<String> {
        None
    }

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
            public_host: None,
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
