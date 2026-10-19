//! [`HourlyCount`] — one row of the hourly connection totals, as the
//! [`ConnectionTotalsStore`](crate::domain::ConnectionTotalsStore) keeps it,
//! and [`HourlyTotals`], every outcome's count for one hour, as the admin
//! API lists them.

use std::collections::BTreeMap;

use crate::domain::Outcome;

/// Seconds in an hour: the totals' bucket.
pub const HOUR_SECS: i64 = 3600;

/// The start of the UTC hour holding `unix_secs` (Unix epoch seconds).
#[must_use]
pub const fn hour_start(unix_secs: i64) -> i64 {
    unix_secs - unix_secs.rem_euclid(HOUR_SECS)
}

/// How many connections in one UTC hour had one outcome. No identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HourlyCount {
    /// The UTC hour's start, Unix epoch seconds.
    pub hour: i64,
    pub outcome: Outcome,
    pub count: u64,
}

/// Every outcome's count in one UTC hour.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HourlyTotals {
    /// The UTC hour's start, Unix epoch seconds.
    pub hour: i64,
    counts: BTreeMap<Outcome, u64>,
}

impl HourlyTotals {
    /// The hour starting at `hour`, with nothing counted yet.
    #[must_use]
    pub fn new(hour: i64) -> Self {
        Self {
            hour,
            counts: BTreeMap::new(),
        }
    }

    /// Add `count` to `outcome`'s count.
    pub fn add(&mut self, outcome: Outcome, count: u64) {
        *self.counts.entry(outcome).or_default() += count;
    }

    /// How many connections in the hour had `outcome`; an outcome never
    /// added is zero.
    #[must_use]
    pub fn count(&self, outcome: Outcome) -> u64 {
        self.counts.get(&outcome).copied().unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_hour_starts_on_the_utc_hour() {
        assert_eq!(hour_start(1_700_000_000), 1_699_999_200);
        assert_eq!(hour_start(1_699_999_200), 1_699_999_200);
        assert_eq!(hour_start(1_700_002_799), 1_699_999_200);
    }

    #[test]
    fn totals_add_up_and_default_to_zero() {
        let mut totals = HourlyTotals::new(0);
        totals.add(Outcome::Ok, 2);
        totals.add(Outcome::Ok, 3);
        assert_eq!(totals.count(Outcome::Ok), 5);
        assert_eq!(totals.count(Outcome::TunnelDown), 0);
    }
}
