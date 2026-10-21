//! How long a client's refresh-token families last: [`RefreshPolicy`], the
//! three refresh columns of its `clients` row.

use chrono::{DateTime, Duration, Utc};
use diesel::prelude::{Insertable, Queryable, Selectable};

use crate::db::clients::{clients, OptionalSeconds};
use crate::domain::refresh_token::REFRESH_TOKEN_FAMILY_CEILING;

/// How long a client's refresh-token families last once it has signed in.
/// Each limit ends a family on its own; [`REFRESH_TOKEN_FAMILY_CEILING`]
/// ends every family whatever the policy says. Read from the client's row
/// on every refresh, so a change applies to its families on their next
/// refresh. Revoking a browser session ends the families minted under it
/// whatever the policy says.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Queryable, Selectable, Insertable)]
#[diesel(table_name = clients)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct RefreshPolicy {
    /// How long a family may go unrefreshed, measured from its last rotation;
    /// `None` for no idle limit.
    #[diesel(
        column_name = refresh_idle_ttl_seconds,
        serialize_as = OptionalSeconds,
        deserialize_as = OptionalSeconds
    )]
    pub idle_ttl: Option<Duration>,
    /// How long a family may last at all, measured from when it was issued;
    /// `None` for only the ceiling.
    #[diesel(
        column_name = refresh_max_ttl_seconds,
        serialize_as = OptionalSeconds,
        deserialize_as = OptionalSeconds
    )]
    pub max_ttl: Option<Duration>,
    /// Whether a family ends when the browser session it was minted under
    /// expires. A family minted under no session (the device flow) has none
    /// to end with, so only the two limits apply to it.
    #[diesel(column_name = refresh_ends_with_browser_session)]
    pub ends_with_browser_session: bool,
}

/// A client trusted on first use that holds any `wildflower/` scope: one that
/// can manage the server ends with the browser session that signed it in, and
/// lasts two hours unused.
const WILDFLOWER_SCOPED_FIRST_USE_POLICY: RefreshPolicy = RefreshPolicy {
    idle_ttl: Some(Duration::hours(2)),
    max_ttl: None,
    ends_with_browser_session: true,
};

/// Any other client trusted on first use: a day unused, a week at most.
const DATA_SCOPED_FIRST_USE_POLICY: RefreshPolicy = RefreshPolicy {
    idle_ttl: Some(Duration::days(1)),
    max_ttl: Some(Duration::days(7)),
    ends_with_browser_session: false,
};

impl RefreshPolicy {
    /// The policy a client trusted on first use starts with, from the scopes
    /// it is registered with: tied to the browser session with a two-hour
    /// idle limit when any is a `wildflower/` scope, otherwise a day idle and
    /// a week at most. Migration `0049` gives an existing client the same
    /// policy by the same rule.
    #[must_use]
    pub fn trusted_on_first_use(allowed_scopes: &[String]) -> Self {
        if allowed_scopes
            .iter()
            .any(|scope| scope.starts_with("wildflower/"))
        {
            WILDFLOWER_SCOPED_FIRST_USE_POLICY
        } else {
            DATA_SCOPED_FIRST_USE_POLICY
        }
    }

    /// When a family under this policy, issued at `family_issued_at` and last
    /// rotated at `last_rotated_at`, ends if nothing refreshes it: the
    /// earliest of its idle limit, its maximum lifetime and the ceiling. The
    /// browser-session rule is not part of it; that is checked against the
    /// session at each refresh.
    #[must_use]
    pub fn family_deadline(
        &self,
        family_issued_at: DateTime<Utc>,
        last_rotated_at: DateTime<Utc>,
    ) -> DateTime<Utc> {
        [
            self.idle_ttl.map(|idle_ttl| last_rotated_at + idle_ttl),
            self.max_ttl.map(|max_ttl| family_issued_at + max_ttl),
        ]
        .into_iter()
        .flatten()
        .fold(
            family_issued_at + REFRESH_TOKEN_FAMILY_CEILING,
            DateTime::min,
        )
    }

    /// Whether a family last rotated at `last_rotated_at` has gone unrefreshed
    /// for its idle limit by `now`. Exactly at the limit counts as idle.
    #[must_use]
    pub fn is_idle_limit_reached(
        &self,
        last_rotated_at: DateTime<Utc>,
        now: DateTime<Utc>,
    ) -> bool {
        self.idle_ttl
            .is_some_and(|idle_ttl| last_rotated_at + idle_ttl <= now)
    }

    /// Whether a family issued at `family_issued_at` has lasted its maximum
    /// lifetime by `now`. Exactly at the limit counts as reached.
    #[must_use]
    pub fn is_max_lifetime_reached(
        &self,
        family_issued_at: DateTime<Utc>,
        now: DateTime<Utc>,
    ) -> bool {
        self.max_ttl
            .is_some_and(|max_ttl| family_issued_at + max_ttl <= now)
    }
}

/// `seconds` as a refresh limit, if a client may hold it: at least a second,
/// and no longer than [`REFRESH_TOKEN_FAMILY_CEILING`], past which the
/// ceiling ends the family anyway.
#[must_use]
pub fn refresh_limit_from_seconds(seconds: i64) -> Option<Duration> {
    Duration::try_seconds(seconds)
        .filter(|limit| *limit > Duration::zero() && *limit <= REFRESH_TOKEN_FAMILY_CEILING)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// The instant `seconds` after the Unix epoch.
    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(seconds, 0).expect("in-range timestamp")
    }

    /// Any `wildflower/` scope ties a first-use client to its browser session
    /// with a two-hour idle limit; any other scope set gets a day idle and a
    /// week at most.
    #[test]
    fn a_first_use_client_s_policy_follows_its_scopes() {
        let scopes = |scopes: &[&str]| scopes.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert_eq!(
            RefreshPolicy::trusted_on_first_use(&scopes(&["openid", "wildflower/Grant.r"])),
            RefreshPolicy {
                idle_ttl: Some(Duration::hours(2)),
                max_ttl: None,
                ends_with_browser_session: true,
            }
        );
        assert_eq!(
            RefreshPolicy::trusted_on_first_use(&scopes(&["openid", "patient/*.rs"])),
            RefreshPolicy {
                idle_ttl: Some(Duration::days(1)),
                max_ttl: Some(Duration::days(7)),
                ends_with_browser_session: false,
            }
        );
        assert_eq!(
            RefreshPolicy::trusted_on_first_use(&[]),
            DATA_SCOPED_FIRST_USE_POLICY
        );
    }

    /// A limit is a positive number of seconds no longer than the ceiling.
    #[test]
    fn a_refresh_limit_is_positive_and_within_the_ceiling() {
        let ceiling_seconds = REFRESH_TOKEN_FAMILY_CEILING.num_seconds();
        assert_eq!(refresh_limit_from_seconds(1), Some(Duration::seconds(1)));
        assert_eq!(
            refresh_limit_from_seconds(ceiling_seconds),
            Some(REFRESH_TOKEN_FAMILY_CEILING)
        );
        assert_eq!(refresh_limit_from_seconds(0), None);
        assert_eq!(refresh_limit_from_seconds(-1), None);
        assert_eq!(refresh_limit_from_seconds(ceiling_seconds + 1), None);
        assert_eq!(refresh_limit_from_seconds(i64::MAX), None);
    }

    /// A limit given as hours, between an hour and a year.
    fn arb_limit() -> impl Strategy<Value = Option<Duration>> {
        prop::option::of((1..=365 * 24i64).prop_map(Duration::hours))
    }

    proptest! {
        /// The deadline is the earliest limit: never past the ceiling or a
        /// limit the policy has, and equal to one of them. At the deadline
        /// the family has reached a limit or the ceiling; a second before it,
        /// neither.
        #[test]
        fn the_deadline_is_the_earliest_limit(
            idle_ttl in arb_limit(),
            max_ttl in arb_limit(),
            issued in 0..1_000_000i64,
            rotated_after in 0..10_000_000i64,
        ) {
            let policy = RefreshPolicy { idle_ttl, max_ttl, ends_with_browser_session: false };
            let issued_at = at(issued);
            let last_rotated_at = at(issued + rotated_after);
            let deadline = policy.family_deadline(issued_at, last_rotated_at);
            let ceiling = issued_at + REFRESH_TOKEN_FAMILY_CEILING;
            let limits = [Some(ceiling), idle_ttl.map(|t| last_rotated_at + t), max_ttl.map(|t| issued_at + t)];
            prop_assert!(limits.iter().flatten().all(|limit| deadline <= *limit));
            prop_assert!(limits.iter().flatten().any(|limit| deadline == *limit));

            let reached = |now| {
                policy.is_idle_limit_reached(last_rotated_at, now)
                    || policy.is_max_lifetime_reached(issued_at, now)
                    || ceiling <= now
            };
            prop_assert!(reached(deadline));
            prop_assert!(!reached(deadline - Duration::seconds(1)));
        }
    }
}
