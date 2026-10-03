//! `tunnel-rust` — the Tauri-side tunnel slice.
//!
//! Layered like `gatekeeper-rust`:
//!
//!  - [`domain`] — pure settings types ([`TunnelSettings`]), the
//!    [`RelayClient`](domain::RelayClient) trait, and the
//!    [`TunnelStore`](domain::TunnelStore) persistence *port* plus the
//!    `actions` the HTTP routes drive it through.
//!  - [`db`] — the [`SqliteTunnelStore`] adapter implementing that port, built
//!    on Diesel over the app-wide r2d2 connection pool
//!    (`persistence_rust::DieselPool`) onto the shared database file, and its
//!    queries.
//!  - `relay_clients` — the embedded `rathole` impl of `RelayClient` that
//!    dials the Wildflower relay.
//!  - [`http`] — the `/tunnel` wire contract.
//!
//! It also keeps the request log: each request the trusted front relayed
//! through the tunnel, as the server's forwarded-request layer reports it on
//! [`Tunnel::request_log_sender`]. A writer task inserts the reports in
//! batches off the request path, trimming each caller class to its row cap
//! ([`domain::request_log`]), and a sweep drops rows past the 30-day window
//! ([`domain::retention`]) at startup and hourly.
//!
//! Settings live in `SQLite` and are API-controlled (`PUT /tunnel`, a
//! full-replace guarded by an optimistic-concurrency `revision`). The relay
//! connection fields are write-only and start empty; until they are set the
//! tunnel reports "not configured". Live runtime state (the [`TunnelStatus`]
//! liveness FSM and any error) is in-memory and resets per process.
//!
//! ## Reconcile + liveness model
//!
//! Every accepted write bumps `revision` and reconciles: the previous
//! [`TunnelState`](live_bindings::state::TunnelState) supervisor is cancelled and a fresh one
//! is spawned for the new revision. A supervisor owns a reconnect/backoff loop, awaits its own
//! rathole child, *and* drives a concurrent `/health` probe — so `servedOrigin`
//! resolves to the public origin only once a probe through it has come back
//! healthy (`status == "verified"`). A post-launch failure
//! surfaces in the `error` field and is retried, and a superseded run's late
//! exit can't clobber the live one.

pub mod config;
mod control;
pub mod db;
pub mod domain;
pub mod health;
pub mod http;
pub mod live_bindings;
mod relay_clients;
#[cfg(test)]
mod test_support;

use std::sync::Arc;

use anyhow::Context;
use axum::Router;
use chrono::Utc;
use shared_structures_rust::request_caller::ForwardedRequest;
use tokio::sync::mpsc;
use tokio::time::{interval, MissedTickBehavior};

pub use config::TunnelConfig;
pub use control::TunnelControl;
pub use db::SqliteTunnelStore;
// The per-slice grantable-scope vocabulary (`wildflower/TunnelSettings.{r,u}`) —
// the scopes the `/tunnel` surface enforces, for a future consent/admin surface.
pub use domain::grantable_tunnel_scopes;
pub use domain::{
    public_origin_url, InvalidPublicHost, RelaySettings, SettingsSeed, TunnelDaemon, TunnelSettings,
};
// The persistence port trait, in scope so `setup_tunnel` can drive the store's
// `seed_if_absent` / `get_settings` methods directly (the trivial reads/seeds the
// domain no longer wraps in an action).
use domain::TunnelStore;
pub use health::HealthProbe;
use live_bindings::state::TunnelState;
// Re-exported so the host can name the pool type at the `setup_tunnel` call site
// without a direct diesel dependency; the canonical home is persistence-rust.
pub use persistence_rust::DieselPool;
use relay_clients::RatholeRelayClient;
// Re-export the tunnel service contract this slice implements, so consumers can
// name the types without depending on `shared-structures-rust` directly.
pub use shared_structures_rust::tunnel_service::{TunnelLiveness, TunnelService, TunnelStatus};

/// How many forwarded-request reports may wait for the request-log writer
/// before the server starts dropping them.
pub const REQUEST_LOG_CAPACITY: usize = 1024;

/// The most reports the request-log writer inserts in one statement. SQLite
/// caps the values one statement binds, and every row binds each column.
const REQUEST_LOG_BATCH_LIMIT: usize = 256;

/// How often the sweep drops logged requests past their retention window (see
/// [`domain::retention`]). Far finer than the 30-day window, so a row is never
/// kept much longer than the policy says.
const REQUEST_LOG_RETENTION_SWEEP_INTERVAL: std::time::Duration =
    std::time::Duration::from_secs(60 * 60);

/// What [`setup_tunnel`] hands back: the `/tunnel` HTTP router to mount, the
/// in-process [`TunnelControl`] seam, and the request log's sender. The
/// composition root threads the control into the apps slice for launch-origin
/// resolution, so a tunnel-requiring launch can trigger the tunnel and read its
/// live public origin without an HTTP round-trip.
pub struct Tunnel {
    pub router: Router,
    pub control: TunnelControl,
    /// Where the server's forwarded-request layer reports each relayed request
    /// for the request log. A full channel drops the report rather than delay a
    /// response; the writer stops once every sender is dropped.
    pub request_log_sender: mpsc::Sender<ForwardedRequest>,
}

/// Build the `/tunnel` router + control seam over the host-owned connection
/// `pool` and an embedded rathole client, mirroring `collector-rust`'s
/// `setup_collector`. The host builds the app-wide diesel pool (via
/// `persistence_rust::open_pool`) and passes it in along with the `probe` adapter
/// the daemon uses to verify the tunnel is actually reachable (it GETs the served
/// origin's assumed-present `/health`). Constructing the store applies the
/// embedded tunnel migrations once, then resumes the tunnel from persisted
/// settings, and starts the request log's writer and retention sweep on the
/// current runtime.
///
/// # Errors
///
/// Returns an error if the store can't be migrated or the persisted settings
/// can't be read.
pub fn setup_tunnel(
    pool: DieselPool,
    config: &TunnelConfig,
    probe: Arc<dyn HealthProbe>,
) -> anyhow::Result<Tunnel> {
    let store = SqliteTunnelStore::new(pool).context("failed to open tunnel store")?;
    let client = Arc::new(RatholeRelayClient::new());
    let tunnel_daemon = TunnelDaemon::new(
        client,
        probe,
        // The daemon renders the loopback origin into `TunnelLiveness.origin` (a
        // wire string), so hand it the bare origin (no trailing slash).
        shared_structures_rust::origin_string(&config.loopback_base_url),
        config
            .loopback_base_url
            .port_or_known_default()
            .expect("loopback_base_url has a known port"),
    );

    let state = Arc::new(TunnelState {
        store,
        daemon: Arc::new(tunnel_daemon),
    });

    // Seed build-time connection defaults into a fresh row (only where
    // unconfigured) before resuming, so a reinstall picks up the baked-in
    // tunnel connection without clobbering any in-app edits.
    state
        .store
        .seed_if_absent(&config.seed)
        .context("failed to seed tunnel settings")?;

    // Resume persisted intent: reconcile spawns a supervisor for the stored
    // revision (a no-op when the tunnel isn't requested or the relay isn't
    // configured).
    let settings = state
        .store
        .get_settings()
        .context("failed to read tunnel settings")?;
    state.daemon.reconcile(&settings);

    // The control seam shares the daemon's liveness watch; a start persists,
    // reconciles, and awaits verification inline (no background task).
    let control = TunnelControl::new(Arc::clone(&state));

    let (request_log_sender, forwarded_requests) = mpsc::channel(REQUEST_LOG_CAPACITY);
    tokio::spawn(write_request_log(state.store.clone(), forwarded_requests));
    spawn_request_log_retention_sweep(state.store.clone());

    Ok(Tunnel {
        router: http::router(state),
        control,
        request_log_sender,
    })
}

/// The request-log writer: it owns `forwarded_requests`, takes whatever has
/// queued (up to [`REQUEST_LOG_BATCH_LIMIT`]) each time it wakes, and records
/// it as one batch ([`domain::request_log::record_requests`]). Returns once
/// every sender is dropped and the queue is drained.
///
/// Runs each batch on [`spawn_blocking`](tokio::task::spawn_blocking): the
/// insert and trims are blocking `SQLite` work. A failed batch is logged and
/// dropped; the log is an observation, and the next batch is unaffected.
async fn write_request_log(
    store: SqliteTunnelStore,
    mut forwarded_requests: mpsc::Receiver<ForwardedRequest>,
) {
    let mut batch = Vec::with_capacity(REQUEST_LOG_BATCH_LIMIT);
    while forwarded_requests
        .recv_many(&mut batch, REQUEST_LOG_BATCH_LIMIT)
        .await
        > 0
    {
        let batch_store = store.clone();
        let requests = std::mem::take(&mut batch);
        let recorded = tokio::task::spawn_blocking(move || {
            domain::request_log::record_requests(&batch_store, &requests)
        })
        .await;
        match recorded {
            Ok(Ok(_evicted)) => {}
            Ok(Err(error)) => tracing::warn!(%error, "request-log batch failed"),
            Err(error) => tracing::warn!(%error, "request-log batch task failed"),
        }
    }
}

/// Spawn the sweep that deletes logged requests past their retention window —
/// once at startup (the interval's immediate first tick), then every
/// [`REQUEST_LOG_RETENTION_SWEEP_INTERVAL`]. A failed sweep is logged and
/// retried next tick.
///
/// Runs on [`spawn_blocking`](tokio::task::spawn_blocking) rather than a runtime
/// worker: `pool.get()` alone can park for r2d2's connection timeout.
fn spawn_request_log_retention_sweep(store: SqliteTunnelStore) {
    tokio::spawn(async move {
        let mut ticks = interval(REQUEST_LOG_RETENTION_SWEEP_INTERVAL);
        // A long pause (suspend/resume) must not queue up catch-up sweeps —
        // one tick after the gap reclaims the same rows anyway.
        ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            // First tick is immediate → startup sweep; then hourly.
            ticks.tick().await;
            let sweep_store = store.clone();
            let swept = tokio::task::spawn_blocking(move || {
                domain::retention::purge_expired(&sweep_store, Utc::now())
            })
            .await;
            match swept {
                Ok(Ok(purged)) if purged > 0 => {
                    tracing::info!(purged, "swept logged requests past their retention window");
                }
                Ok(Ok(_)) => {}
                Ok(Err(error)) => tracing::warn!(%error, "request-log retention sweep failed"),
                Err(error) => tracing::warn!(%error, "request-log retention sweep task failed"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use std::time::SystemTime;

    use super::*;
    use crate::db::tunnel_requests::test_support::{forwarded_request, logged_client_ids};

    /// The writer records every queued report, in arrival order, and returns
    /// once its senders are gone.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_writer_records_each_report_and_stops_with_its_senders() {
        let store = SqliteTunnelStore::open_in_memory().expect("store");
        let (request_log_sender, forwarded_requests) = mpsc::channel(REQUEST_LOG_CAPACITY);
        let now = SystemTime::now();
        for client_id in [Some("lifting"), None, Some("viewer")] {
            request_log_sender
                .try_send(forwarded_request(client_id, now))
                .expect("room in the channel");
        }
        drop(request_log_sender);

        write_request_log(store.clone(), forwarded_requests).await;

        assert_eq!(
            logged_client_ids(&store),
            vec![Some("lifting".to_owned()), None, Some("viewer".to_owned())]
        );
    }
}
