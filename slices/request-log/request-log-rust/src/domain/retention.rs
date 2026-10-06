//! Retention policy for the request log — the window itself plus
//! `purge_expired`, the sweep that applies it. The row caps in
//! [`request_log`](crate::domain::request_log) bound the log's size; this bounds
//! its age.

use chrono::{DateTime, Duration, Utc};

use crate::domain::request_log::RequestLogStore;
use crate::domain::RequestLogError;

/// How long a logged request is kept after it arrived.
pub const REQUEST_LOG_RETENTION: Duration = Duration::days(30);

/// Delete every logged request older than [`REQUEST_LOG_RETENTION`] as of
/// `now`, returning how many went. Idempotent — a second pass at the same `now`
/// matches nothing. The caller logs only a non-zero count, so an idle device
/// produces no log noise.
///
/// `now` is a parameter rather than a `Utc::now()` inside, so tests can place
/// rows either side of the window without sleeping. The window is turned into a
/// cutoff here; the store primitive never sees the policy constant.
///
/// # Errors
///
/// [`RequestLogError::Infrastructure`] if the delete fails.
pub(crate) fn purge_expired(
    store: &impl RequestLogStore,
    now: DateTime<Utc>,
) -> Result<usize, RequestLogError> {
    store.delete_requests_received_before(now - REQUEST_LOG_RETENTION)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::logged_requests::test_support::forwarded_request;
    use crate::db::SqliteRequestLogStore;

    /// A fixed "now" so rows can be placed either side of the window without a
    /// clock read.
    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-07-01T12:00:00Z")
            .expect("fixed instant")
            .with_timezone(&Utc)
    }

    /// A store holding one request 31 days old, one 29 days old and one from
    /// `now`.
    fn seeded() -> SqliteRequestLogStore {
        let store = SqliteRequestLogStore::open_in_memory().expect("store");
        store
            .insert_requests(&[
                forwarded_request(Some("lifting"), (now() - Duration::days(31)).into()),
                forwarded_request(None, (now() - Duration::days(29)).into()),
                forwarded_request(Some("lifting"), now().into()),
            ])
            .expect("seed");
        store
    }

    #[test]
    fn purges_past_the_window_and_spares_everything_inside_it() {
        let store = seeded();

        assert_eq!(purge_expired(&store, now()).expect("sweep"), 1);
        // The 29-day-old row goes once the window passes it.
        assert_eq!(
            purge_expired(&store, now() + Duration::days(2)).expect("later sweep"),
            1
        );
    }

    /// A second pass at the same instant finds nothing left in range, so the
    /// hourly timer re-running over a quiet log is a no-op.
    #[test]
    fn a_second_pass_at_the_same_now_reclaims_nothing() {
        let store = seeded();
        assert_eq!(purge_expired(&store, now()).expect("first sweep"), 1);

        assert_eq!(purge_expired(&store, now()).expect("second sweep"), 0);
    }
}
