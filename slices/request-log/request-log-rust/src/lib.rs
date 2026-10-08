//! `request-log-rust` — the host-side request-log slice: each forwarded request
//! the server served (through the tunnel, or relayed by a front run on its
//! machine), as the server's forwarded-request layer reports it on [`RequestLog::sender`], kept in the shared database and served
//! back on the `/requests` HTTP surface.
//!
//! A writer task inserts the reports in batches off the request path, trimming
//! each caller class to its row cap ([`domain::request_log`]), and a sweep drops
//! rows past the 30-day window ([`domain::retention`]) at startup and hourly.
//!
//! Layered like `collector-rust`:
//!
//!  - [`domain`] — the log's types, the
//!    [`RequestLogStore`](domain::RequestLogStore) persistence port, the
//!    [`record_requests`](domain::request_log::record_requests) action the writer
//!    runs, and the scope-gated capability the handlers acquire.
//!  - `live_bindings` — the router state and the `FixedScopeCapability` binding
//!    that names the concrete store, kept out of [`http`] so `domain/` can build
//!    capabilities from it without depending on the transport layer.
//!  - [`db`] — the [`SqliteRequestLogStore`] adapter, built on Diesel over the
//!    app-wide r2d2 connection pool (`persistence_rust::DieselPool`) onto the
//!    shared database file.
//!  - [`http`] — `GET /requests` and `GET /requests/callers`, gated by
//!    `wildflower/RequestLog.r`; the wire contract is pinned from both sides by
//!    the committed OpenAPI snapshot.

pub mod db;
pub mod domain;
pub mod http;
pub(crate) mod live_bindings;

use std::sync::Arc;

use anyhow::Context;
use axum::Router;
use chrono::Utc;
use shared_structures_rust::request_caller::ForwardedRequest;
use tokio::sync::mpsc;
use tokio::time::{interval, MissedTickBehavior};

pub use db::SqliteRequestLogStore;
// The per-slice grantable-scope vocabulary (`wildflower/RequestLog.r`) — the
// scope the `/requests` surface enforces, for a future consent/admin surface.
pub use domain::capabilities::grantable_request_log_scopes;
pub use live_bindings::state::RequestLogState;
// Re-exported so the host can name the pool type at the `setup_request_log`
// call site without a direct diesel dependency; the canonical home is
// persistence-rust.
pub use persistence_rust::DieselPool;

/// How many forwarded-request reports may wait for the writer before the
/// server starts dropping them.
pub const REQUEST_LOG_CAPACITY: usize = 1024;

/// The most reports the writer inserts in one statement. SQLite caps the values
/// one statement binds, and every row binds each column.
const REQUEST_LOG_BATCH_LIMIT: usize = 256;

/// How often the sweep drops logged requests past their retention window (see
/// [`domain::retention`]). Far finer than the 30-day window, so a row is never
/// kept much longer than the policy says.
const REQUEST_LOG_RETENTION_SWEEP_INTERVAL: std::time::Duration =
    std::time::Duration::from_secs(60 * 60);

/// What [`setup_request_log`] hands back: the `/requests` HTTP router to mount,
/// and where the server's forwarded-request layer reports each forwarded request.
pub struct RequestLog {
    pub router: Router,
    /// A full channel drops the report rather than delay a response; the writer
    /// stops once every sender is dropped.
    pub sender: mpsc::Sender<ForwardedRequest>,
}

/// Build the request log over the host-owned connection `pool`, mirroring
/// `collector-rust`'s `setup_collector`. Constructing the store applies the
/// embedded request-log migrations once; the writer and the retention sweep
/// start on the current runtime.
///
/// The returned router carries no middleware, but every endpoint is scope-gated
/// (the handlers take a `Scoped<…>` capability). The consumer MUST still layer
/// it with its auth gate (the server applies
/// `gatekeeper_rust::gatekeeper_auth_middleware`), which inserts the
/// `ScopeClaims` the capability reads, so an ungated router fails closed with a
/// 500 rather than admitting an unauthenticated caller.
///
/// # Errors
///
/// Returns an error if the store can't run its migrations on a pooled
/// connection.
pub fn setup_request_log(pool: DieselPool) -> anyhow::Result<RequestLog> {
    let store = SqliteRequestLogStore::new(pool).context("failed to open request-log store")?;

    let (sender, forwarded_requests) = mpsc::channel(REQUEST_LOG_CAPACITY);
    tokio::spawn(write_request_log(store.clone(), forwarded_requests));
    spawn_request_log_retention_sweep(store.clone());

    Ok(RequestLog {
        router: http::router(Arc::new(RequestLogState::new(store))),
        sender,
    })
}

/// The writer: it owns `forwarded_requests`, takes whatever has queued (up to
/// [`REQUEST_LOG_BATCH_LIMIT`]) each time it wakes, and records it as one batch
/// ([`domain::request_log::record_requests`]). Returns once every sender is
/// dropped and the queue is drained.
///
/// Runs each batch on [`spawn_blocking`](tokio::task::spawn_blocking): the
/// insert and trims are blocking `SQLite` work. A failed batch is logged and
/// dropped; the log is an observation, and the next batch is unaffected.
async fn write_request_log(
    store: SqliteRequestLogStore,
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
fn spawn_request_log_retention_sweep(store: SqliteRequestLogStore) {
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
    use crate::db::logged_requests::test_support::{forwarded_request, logged_client_ids};

    /// The writer records every queued report, in arrival order, and returns
    /// once its senders are gone.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_writer_records_each_report_and_stops_with_its_senders() {
        let store = SqliteRequestLogStore::open_in_memory().expect("store");
        let (sender, forwarded_requests) = mpsc::channel(REQUEST_LOG_CAPACITY);
        let now = SystemTime::now();
        for client_id in [Some("lifting"), None, Some("viewer")] {
            sender
                .try_send(forwarded_request(client_id, now))
                .expect("room in the channel");
        }
        drop(sender);

        write_request_log(store.clone(), forwarded_requests).await;

        assert_eq!(
            logged_client_ids(&store),
            vec![Some("lifting".to_owned()), None, Some("viewer".to_owned())]
        );
    }
}
