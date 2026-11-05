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
    /// a week at most. Migration `0050` gives an existing client the same
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
