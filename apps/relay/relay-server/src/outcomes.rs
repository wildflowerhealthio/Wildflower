//! [`ConnectionOutcomes`] — what the front records about each `:443`
//! connection, shared with the admin API. It holds two things, both in
//! memory:
//!
//! - **The last outcome per tunnel.** One [`TunnelOutcome`] per tunnel
//!   name, and nothing else: no time, no count, no bytes. Only a tunnel the
//!   relay serves is ever a key, so it holds at most one entry per tunnel,
//!   and deleting a tunnel removes its entry. A restart clears it.
//! - **The hourly counts not yet flushed.** How many connections had each
//!   [`Outcome`] in each UTC hour, keyed by the hour and the outcome alone.
//!   The flush (see
//!   [`TunnelRegistry::flush_connection_totals`](crate::TunnelRegistry::flush_connection_totals))
//!   takes them every minute and adds them to the database's totals.
//!
//! The front counts each connection once, at the point its outcome is
//! known: for a piped connection, when the PROXY header and hello reach the
//! tunnel. Nothing reads or counts the bytes after that.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::domain::{hour_start, HourlyCount, Outcome, TunnelOutcome};
use crate::served::ServedTunnels;
use crate::site::signature::unix_now;

/// The last outcome per tunnel and the hourly counts not yet flushed.
#[derive(Debug)]
pub struct ConnectionOutcomes {
    /// Which tunnels may hold a last outcome: only served ones.
    served: Arc<ServedTunnels>,
    last_by_tunnel: Mutex<HashMap<String, TunnelOutcome>>,
    /// `(UTC hour start, outcome) → count`.
    pending: Mutex<HashMap<(i64, Outcome), u64>>,
}

impl ConnectionOutcomes {
    /// Nothing recorded yet, keeping last outcomes only for tunnels in
    /// `served`.
    #[must_use]
    pub fn new(served: Arc<ServedTunnels>) -> Self {
        Self {
            served,
            last_by_tunnel: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// Record a connection routed to the tunnel `tunnel_name`: it becomes
    /// that tunnel's last outcome, and is counted in the current hour. A
    /// tunnel no longer served (deleted while the connection was routed) is
    /// counted but keeps no entry.
    pub fn record_for_tunnel(&self, tunnel_name: &str, outcome: TunnelOutcome) {
        {
            // Checked under the lock `forget` takes, and `forget` runs after
            // the tunnel stops being served, so a deleted tunnel's entry
            // cannot come back.
            let mut last_by_tunnel = lock(&self.last_by_tunnel);
            if self.served.contains(tunnel_name) {
                last_by_tunnel.insert(tunnel_name.to_owned(), outcome);
            }
        }
        self.count(outcome.into());
    }

    /// Record a connection refused before any tunnel was known: counted in
    /// the current hour only.
    pub fn record(&self, outcome: Outcome) {
        self.count(outcome);
    }

    /// The last outcome of a connection to the tunnel `tunnel_name` since
    /// the relay started (or since the tunnel was created), if it has had
    /// one.
    #[must_use]
    pub fn last_outcome(&self, tunnel_name: &str) -> Option<TunnelOutcome> {
        lock(&self.last_by_tunnel).get(tunnel_name).copied()
    }

    /// Drop the tunnel `tunnel_name`'s last outcome. The registry calls it
    /// when the tunnel is deleted, after it stops being served, so a tunnel
    /// created later under the same name starts with none.
    pub fn forget(&self, tunnel_name: &str) {
        lock(&self.last_by_tunnel).remove(tunnel_name);
    }

    /// The counts not yet flushed, without taking them.
    #[must_use]
    pub fn pending(&self) -> Vec<HourlyCount> {
        lock(&self.pending)
            .iter()
            .map(|(&(hour, outcome), &count)| HourlyCount {
                hour,
                outcome,
                count,
            })
            .collect()
    }

    /// Take the counts not yet flushed, leaving none.
    #[must_use]
    pub fn take_pending(&self) -> Vec<HourlyCount> {
        std::mem::take(&mut *lock(&self.pending))
            .into_iter()
            .map(|((hour, outcome), count)| HourlyCount {
                hour,
                outcome,
                count,
            })
            .collect()
    }

    /// Put back counts [`ConnectionOutcomes::take_pending`] took, for a
    /// flush that could not store them, adding them to any counted since.
    pub fn restore_pending(&self, counts: &[HourlyCount]) {
        let mut pending = lock(&self.pending);
        for counted in counts {
            *pending.entry((counted.hour, counted.outcome)).or_default() += counted.count;
        }
    }

    /// Count `outcome` in the current UTC hour.
    fn count(&self, outcome: Outcome) {
        match unix_now() {
            Ok(now) => self.count_at(outcome, now),
            Err(error) => {
                tracing::warn!("a connection was not counted: reading the clock failed: {error:#}");
            }
        }
    }

    /// Count `outcome` in the UTC hour holding `unix_secs`.
    fn count_at(&self, outcome: Outcome, unix_secs: i64) {
        *lock(&self.pending)
            .entry((hour_start(unix_secs), outcome))
            .or_default() += 1;
    }
}

/// Lock `mutex`. A poisoned lock only means a holder panicked between
/// whole-entry updates; the map inside is still whole.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::Tunnel;
    use crate::settings::Secret;

    fn tunnel(name: &str) -> Tunnel {
        Tunnel {
            name: name.to_owned(),
            token: Secret::new(format!("{name}-token")),
        }
    }

    /// Outcomes keeping last outcomes for `alice` and `bob`.
    fn outcomes() -> (ConnectionOutcomes, Arc<ServedTunnels>) {
        let served = Arc::new(ServedTunnels::new(&[tunnel("alice"), tunnel("bob")]));
        (ConnectionOutcomes::new(Arc::clone(&served)), served)
    }

    fn total(outcomes: &ConnectionOutcomes, outcome: Outcome) -> u64 {
        outcomes
            .pending()
            .iter()
            .filter(|counted| counted.outcome == outcome)
            .map(|counted| counted.count)
            .sum()
    }

    #[test]
    fn a_routed_outcome_sets_the_tunnels_value_until_the_next_replaces_it() {
        let (outcomes, _served) = outcomes();
        assert_eq!(outcomes.last_outcome("alice"), None);

        outcomes.record_for_tunnel("alice", TunnelOutcome::TunnelDown);
        assert_eq!(
            outcomes.last_outcome("alice"),
            Some(TunnelOutcome::TunnelDown)
        );
        assert_eq!(outcomes.last_outcome("bob"), None);

        outcomes.record_for_tunnel("alice", TunnelOutcome::Ok);
        assert_eq!(outcomes.last_outcome("alice"), Some(TunnelOutcome::Ok));
        assert_eq!(total(&outcomes, Outcome::TunnelDown), 1);
        assert_eq!(total(&outcomes, Outcome::Ok), 1);
    }

    #[test]
    fn refusals_before_routing_leave_the_per_tunnel_map_untouched() {
        let (outcomes, _served) = outcomes();
        for outcome in [
            Outcome::OverConnectionLimit,
            Outcome::HelloTimeout,
            Outcome::NotAHello,
            Outcome::NoServerName,
            Outcome::UnknownTunnel,
        ] {
            outcomes.record(outcome);
            assert_eq!(total(&outcomes, outcome), 1);
        }
        assert!(lock(&outcomes.last_by_tunnel).is_empty());
    }

    #[test]
    fn a_deleted_tunnel_keeps_no_entry() {
        let (outcomes, served) = outcomes();
        outcomes.record_for_tunnel("alice", TunnelOutcome::Ok);

        served.remove("alice");
        outcomes.forget("alice");
        assert_eq!(outcomes.last_outcome("alice"), None);

        // A connection routed before the delete, recording after it, is
        // still counted but leaves no entry for the name.
        outcomes.record_for_tunnel("alice", TunnelOutcome::TunnelDown);
        assert_eq!(outcomes.last_outcome("alice"), None);
        assert_eq!(total(&outcomes, Outcome::TunnelDown), 1);

        // Created again under the same name, it starts with no outcome.
        served.insert(&tunnel("alice"));
        assert_eq!(outcomes.last_outcome("alice"), None);
    }

    #[test]
    fn counts_land_in_the_utc_hour_start() {
        let (outcomes, _served) = outcomes();
        outcomes.count_at(Outcome::Ok, 1_700_000_000);
        outcomes.count_at(Outcome::Ok, 1_700_002_799);
        outcomes.count_at(Outcome::Ok, 1_700_002_800);
        let mut pending = outcomes.pending();
        pending.sort_by_key(|counted| counted.hour);
        assert_eq!(
            pending,
            [
                HourlyCount {
                    hour: 1_699_999_200,
                    outcome: Outcome::Ok,
                    count: 2
                },
                HourlyCount {
                    hour: 1_700_002_800,
                    outcome: Outcome::Ok,
                    count: 1
                },
            ]
        );
    }

    #[test]
    fn taken_counts_are_gone_until_restored_on_top_of_new_ones() {
        let (outcomes, _served) = outcomes();
        outcomes.count_at(Outcome::Ok, 1_700_000_000);
        let taken = outcomes.take_pending();
        assert!(outcomes.pending().is_empty());

        outcomes.count_at(Outcome::Ok, 1_700_000_000);
        outcomes.restore_pending(&taken);
        assert_eq!(
            outcomes.pending(),
            [HourlyCount {
                hour: 1_699_999_200,
                outcome: Outcome::Ok,
                count: 2
            }]
        );
    }
}
