//! The read capability for the hourly connection totals —
//! [`ConnectionTotalsReader`], for `GET /api/connection-totals`.
//!
//! The totals are counted in memory and flushed to the store every minute,
//! so a read merges the stored counts with the ones not flushed yet.

use std::collections::BTreeMap;

use crate::domain::{hour_start, ConnectionTotalsStore, HourlyCount, HourlyTotals, TunnelError};

/// How long the totals are kept: 30 days. The flush deletes older hours,
/// and the read leaves them out.
pub(crate) const TOTALS_RETENTION_SECS: i64 = 30 * 24 * 3600;

/// The first hour still kept at `now` (Unix epoch seconds): the totals hold
/// the hours from it on.
pub(crate) const fn oldest_kept_hour(now: i64) -> i64 {
    hour_start(now) - TOTALS_RETENTION_SECS
}

/// Read access to the hourly totals — `GET /api/connection-totals`. Generic
/// over the store port so the merge is exercised against the in-memory
/// fake.
pub(crate) struct ConnectionTotalsReader<S: ConnectionTotalsStore> {
    store: S,
}

impl<S: ConnectionTotalsStore> ConnectionTotalsReader<S> {
    pub(crate) fn new(store: S) -> Self {
        Self { store }
    }

    /// Every hour of the last 30 days, at the time `now` reads (Unix epoch
    /// seconds), that has any count, oldest first: the stored counts plus
    /// `pending`, the counts not flushed yet.
    ///
    /// # Errors
    ///
    /// Whatever `now` fails with, or [`TunnelError::Infrastructure`] if the
    /// store read fails.
    pub(crate) fn list(
        &self,
        pending: &[HourlyCount],
        now: impl FnOnce() -> Result<i64, TunnelError>,
    ) -> Result<Vec<HourlyTotals>, TunnelError> {
        let since = oldest_kept_hour(now()?);
        let stored = self.store.connection_totals_since(since)?;
        let mut by_hour: BTreeMap<i64, HourlyTotals> = BTreeMap::new();
        for counted in stored
            .iter()
            .chain(pending.iter().filter(|counted| counted.hour >= since))
        {
            by_hour
                .entry(counted.hour)
                .or_insert_with(|| HourlyTotals::new(counted.hour))
                .add(counted.outcome, counted.count);
        }
        Ok(by_hour.into_values().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::FakeTunnelStore;
    use crate::domain::Outcome;

    const NOW: i64 = 1_700_000_000;
    const HOUR: i64 = hour_start(NOW);

    fn counted(hour: i64, outcome: Outcome, count: u64) -> HourlyCount {
        HourlyCount {
            hour,
            outcome,
            count,
        }
    }

    #[test]
    fn merges_stored_and_pending_counts_by_hour_oldest_first() {
        let store = FakeTunnelStore::default();
        store
            .add_connection_totals(&[
                counted(HOUR, Outcome::Ok, 2),
                counted(HOUR - 3600, Outcome::TunnelDown, 1),
            ])
            .unwrap();
        let reader = ConnectionTotalsReader::new(store);

        let listed = reader
            .list(
                &[
                    counted(HOUR, Outcome::Ok, 3),
                    counted(HOUR, Outcome::UnknownTunnel, 4),
                ],
                || Ok(NOW),
            )
            .unwrap();

        assert_eq!(
            listed.iter().map(|totals| totals.hour).collect::<Vec<_>>(),
            [HOUR - 3600, HOUR]
        );
        assert_eq!(listed[0].count(Outcome::TunnelDown), 1);
        assert_eq!(listed[1].count(Outcome::Ok), 5);
        assert_eq!(listed[1].count(Outcome::UnknownTunnel), 4);
        assert_eq!(listed[1].count(Outcome::TunnelDown), 0);
    }

    /// The hour 30 days back is still kept; the one before it is not, even
    /// if the flush has not deleted it yet.
    #[test]
    fn leaves_out_hours_older_than_30_days() {
        let store = FakeTunnelStore::default();
        let oldest = HOUR - TOTALS_RETENTION_SECS;
        store
            .add_connection_totals(&[
                counted(oldest, Outcome::Ok, 1),
                counted(oldest - 3600, Outcome::Ok, 1),
            ])
            .unwrap();
        let reader = ConnectionTotalsReader::new(store);

        let listed = reader
            .list(&[counted(oldest - 3600, Outcome::Ok, 1)], || Ok(NOW))
            .unwrap();

        assert_eq!(
            listed.iter().map(|totals| totals.hour).collect::<Vec<_>>(),
            [oldest]
        );
    }
}
