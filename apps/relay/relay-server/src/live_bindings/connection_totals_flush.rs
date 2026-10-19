//! `TunnelRegistry::flush_connection_totals` — the relay task that moves the
//! hourly counts the front keeps in memory (see
//! [`ConnectionOutcomes`](crate::outcomes::ConnectionOutcomes)) into the
//! store's totals every minute, and once more on shutdown, so a crash loses
//! at most a minute of counts. Each flush also deletes the hours older than
//! 30 days.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::broadcast;
use tokio::time::Instant;

use super::on_blocking;
use super::state::TunnelRegistry;
use crate::domain::capabilities::oldest_kept_hour;
use crate::domain::{ConnectionTotalsStore, TunnelError};
use crate::site::signature::unix_now;

/// How often the counts are flushed.
const FLUSH_INTERVAL: Duration = Duration::from_secs(60);

impl TunnelRegistry {
    /// Flush the hourly counts every minute, and once more when
    /// `shutdown_rx` fires, then return. A flush that fails is logged to the
    /// journal and its counts are kept for the next.
    ///
    /// # Errors
    ///
    /// Currently never; the `Result` keeps the signature in line with the
    /// other relay tasks it is joined with.
    pub async fn flush_connection_totals(
        self: Arc<Self>,
        mut shutdown_rx: broadcast::Receiver<bool>,
    ) -> anyhow::Result<()> {
        let mut interval =
            tokio::time::interval_at(Instant::now() + FLUSH_INTERVAL, FLUSH_INTERVAL);
        loop {
            let shutting_down = tokio::select! {
                _ = interval.tick() => false,
                _ = shutdown_rx.recv() => true,
            };
            self.flush_connection_totals_once().await;
            if shutting_down {
                return Ok(());
            }
        }
    }

    /// Add the pending counts to the store, putting them back if that fails,
    /// then delete the stored hours older than 30 days.
    pub(crate) async fn flush_connection_totals_once(&self) {
        let _flushing = self.totals_flush.lock().await;
        let pending = self.outcomes.take_pending();
        if !pending.is_empty() {
            let store = self.store.clone();
            let counts = pending.clone();
            let added = on_blocking(move || store.add_connection_totals(&counts)).await;
            if let Err(error) = added {
                tracing::error!("storing the hourly connection totals failed: {error}");
                self.outcomes.restore_pending(&pending);
            }
        }
        let store = self.store.clone();
        let pruned = on_blocking(move || {
            let now = unix_now()
                .map_err(|e| TunnelError::infrastructure("reading the clock failed", e))?;
            store.delete_connection_totals_before(oldest_kept_hour(now))
        })
        .await;
        if let Err(error) = pruned {
            tracing::error!("deleting old hourly connection totals failed: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{hour_start, HourlyCount, Outcome};
    use crate::test_support::registry;

    fn hour_now() -> i64 {
        hour_start(unix_now().unwrap())
    }

    #[tokio::test]
    async fn a_flush_moves_the_pending_counts_into_the_store() {
        let (registry, _fixture) = registry(None).await;
        registry.outcomes.record(Outcome::UnknownTunnel);
        registry.outcomes.record(Outcome::UnknownTunnel);

        registry.flush_connection_totals_once().await;
        registry.outcomes.record(Outcome::UnknownTunnel);
        registry.flush_connection_totals_once().await;

        assert!(registry.outcomes.pending().is_empty());
        let stored = registry
            .store
            .connection_totals_since(hour_now() - 3600)
            .unwrap();
        // A flush that straddles the hour splits the counts across two rows.
        assert_eq!(stored.iter().map(|counted| counted.count).sum::<u64>(), 3);
        assert!(stored
            .iter()
            .all(|counted| counted.outcome == Outcome::UnknownTunnel));
    }

    #[tokio::test]
    async fn a_flush_deletes_hours_older_than_30_days() {
        let (registry, _fixture) = registry(None).await;
        let oldest = oldest_kept_hour(unix_now().unwrap());
        let counted = |hour| HourlyCount {
            hour,
            outcome: Outcome::Ok,
            count: 1,
        };
        registry
            .store
            .add_connection_totals(&[counted(oldest), counted(oldest - 3600)])
            .unwrap();

        registry.flush_connection_totals_once().await;

        let stored = registry.store.connection_totals_since(0).unwrap();
        // Unless the hour turned between reading `oldest` and the flush.
        assert!(
            stored.iter().all(|counted| counted.hour >= oldest),
            "{stored:?}"
        );
        assert!(stored.len() <= 1, "{stored:?}");
    }

    #[tokio::test]
    async fn a_failed_flush_keeps_the_counts_for_the_next() {
        let (registry, _fixture) = registry(None).await;
        registry.outcomes.record(Outcome::HelloTimeout);
        registry
            .store
            .execute("ALTER TABLE connection_totals RENAME TO unreachable");

        registry.flush_connection_totals_once().await;

        let pending = registry.outcomes.pending();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].count, 1);
    }

    #[tokio::test]
    async fn shutdown_flushes_once_more_and_stops() {
        let (registry, _fixture) = registry(None).await;
        let (shutdown_tx, shutdown_rx) = broadcast::channel(1);
        let task = tokio::spawn(Arc::clone(&registry).flush_connection_totals(shutdown_rx));
        registry.outcomes.record(Outcome::NotAHello);

        shutdown_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("the flush task stops on shutdown")
            .unwrap()
            .unwrap();

        assert!(registry.outcomes.pending().is_empty());
        let stored = registry.store.connection_totals_since(0).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].outcome, Outcome::NotAHello);
    }
}
