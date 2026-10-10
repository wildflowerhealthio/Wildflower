//! The request log: the forwarded requests the server served (through the
//! tunnel, or relayed by a front run on its machine), kept on the device. The [`RequestLogStore`] port, the row caps that bound it,
//! [`record_requests`], the action the request-log writer runs on each batch,
//! and the shapes the log is read back in: a page of [`LoggedRequest`]s and one
//! [`CallerSummary`] per caller. Its time-based retention is
//! [`crate::domain::retention`].
//!
//! Each row is a [`ForwardedRequest`] the server's forwarded-request layer
//! reported. The record holds no record identifiers (its path is reduced to the
//! route), and the client's display name is not stored: readers resolve it from
//! the `client_id` through gatekeeper.

use chrono::{DateTime, Utc};
use wildflowerhealthio_shared_structures::request_caller::{
    ForwardedRequest, RequestCaller, RequestRefusal,
};

use crate::domain::RequestLogError;

/// The most rows kept for requests that carried a verified caller.
pub const VERIFIED_CALLER_ROW_CAP: i64 = 100_000;

/// The most rows kept for requests no bearer gate verified: ungated, or refused
/// with a `401`. Separate from [`VERIFIED_CALLER_ROW_CAP`] so a flood of
/// refused requests only evicts other refused requests.
pub const UNVERIFIED_CALLER_ROW_CAP: i64 = 20_000;

/// The most requests one page of the log holds.
pub const REQUEST_LOG_PAGE_SIZE: i64 = 100;

/// The response statuses that count a request as refused: a bearer gate's
/// `401`, or a `403` for a token too narrow for the route.
pub const REFUSED_STATUSES: [u16; 2] = [401, 403];

/// One request in the log, under the id that orders it (a higher id is newer).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoggedRequest {
    pub id: i64,
    pub request: ForwardedRequest,
}

/// Which logged requests a page reads, newest first. Every filter that is set
/// must match.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RequestLogFilter {
    /// Only requests older than this id: the previous page's
    /// [`RequestLogPage::next_cursor`].
    pub before_id: Option<i64>,
    /// Only requests whose verified caller is this client.
    pub client_id: Option<String>,
    /// Only requests from this client address.
    pub client_address: Option<String>,
    /// Only requests in this auth case.
    pub auth: Option<RequestAuth>,
}

/// How a logged request fared against auth, from its verified caller and
/// status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestAuth {
    /// It needed auth and its token was valid: a verified caller, and a status
    /// outside [`REFUSED_STATUSES`].
    Authorized,
    /// It didn't need auth: no verified caller, and a status outside
    /// [`REFUSED_STATUSES`].
    Public,
    /// It failed auth: a status in [`REFUSED_STATUSES`].
    Refused,
}

/// One page of the log, newest first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestLogPage {
    /// At most [`REQUEST_LOG_PAGE_SIZE`] requests.
    pub requests: Vec<LoggedRequest>,
    /// The `before_id` that reads the next page, or `None` on the last one.
    pub next_cursor: Option<i64>,
}

/// What the log holds for one (caller, client address) pair: one row of
/// `GET /requests/callers`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallerSummary {
    /// The verified caller, or `None` for the requests no bearer gate verified.
    pub caller: Option<RequestCaller>,
    pub client_address: Option<String>,
    pub first_seen: DateTime<Utc>,
    pub last_seen: DateTime<Utc>,
    pub request_count: i64,
    /// How many of them were refused (see [`REFUSED_STATUSES`]).
    pub refused_count: i64,
    /// The newest request's status.
    pub last_status: u16,
    /// The newest request's refusal, if a bearer gate refused it.
    pub last_refusal: Option<RequestRefusal>,
}

/// Which row cap a logged request counts against: whether a bearer gate
/// verified its caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallerClass {
    /// A bearer gate verified the caller (its response may still be a scope
    /// `403`).
    Verified,
    /// No bearer gate verified a caller.
    Unverified,
}

impl CallerClass {
    /// The class `forwarded_request` counts against.
    #[must_use]
    pub fn of(forwarded_request: &ForwardedRequest) -> Self {
        match forwarded_request.caller {
            Some(_) => Self::Verified,
            None => Self::Unverified,
        }
    }

    /// The most rows this class keeps.
    #[must_use]
    pub fn row_cap(self) -> i64 {
        match self {
            Self::Verified => VERIFIED_CALLER_ROW_CAP,
            Self::Unverified => UNVERIFIED_CALLER_ROW_CAP,
        }
    }
}

/// The persistence port for the request log, implemented by
/// [`SqliteRequestLogStore`](crate::db::SqliteRequestLogStore). Rows are numbered in arrival order, so a higher id is a newer request.
pub trait RequestLogStore {
    /// Append `requests`, oldest first, in one insert.
    ///
    /// # Errors
    ///
    /// [`RequestLogError::Infrastructure`] on a checkout / insert failure.
    fn insert_requests(&self, requests: &[ForwardedRequest]) -> Result<(), RequestLogError>;

    /// Delete `caller_class`'s rows at least `row_cap` ids behind its newest
    /// one, oldest first, returning how many went. An id-range delete within
    /// the class: the class keeps at most `row_cap` rows (fewer while the other
    /// class's rows sit between them), and the other class is untouched.
    ///
    /// # Errors
    ///
    /// [`RequestLogError::Infrastructure`] on a checkout / delete failure.
    fn delete_requests_beyond_cap(
        &self,
        caller_class: CallerClass,
        row_cap: i64,
    ) -> Result<usize, RequestLogError>;

    /// The page of the log `filter` selects: at most [`REQUEST_LOG_PAGE_SIZE`]
    /// requests, newest first.
    ///
    /// # Errors
    ///
    /// [`RequestLogError::Infrastructure`] on a checkout / read failure, or a row
    /// the log could not have written.
    fn requests_page(&self, filter: &RequestLogFilter) -> Result<RequestLogPage, RequestLogError>;

    /// The log grouped by (caller, client address), the group with the newest
    /// request first.
    ///
    /// # Errors
    ///
    /// [`RequestLogError::Infrastructure`] on a checkout / read failure, or a row
    /// the log could not have written.
    fn caller_summaries(&self) -> Result<Vec<CallerSummary>, RequestLogError>;

    /// Delete every row received before `cutoff`, returning how many went.
    ///
    /// # Errors
    ///
    /// [`RequestLogError::Infrastructure`] on a checkout / delete failure.
    fn delete_requests_received_before(
        &self,
        cutoff: chrono::DateTime<chrono::Utc>,
    ) -> Result<usize, RequestLogError>;
}

/// Append `requests` to the log, then trim each class back to its row cap,
/// returning how many rows the caps evicted.
///
/// # Errors
///
/// [`RequestLogError::Infrastructure`] if the insert or a trim fails. A failed trim
/// leaves the batch inserted; the next batch's trim catches up.
pub fn record_requests(
    store: &impl RequestLogStore,
    requests: &[ForwardedRequest],
) -> Result<usize, RequestLogError> {
    store.insert_requests(requests)?;
    let mut evicted = 0;
    for caller_class in [CallerClass::Verified, CallerClass::Unverified] {
        evicted += store.delete_requests_beyond_cap(caller_class, caller_class.row_cap())?;
    }
    Ok(evicted)
}

#[cfg(test)]
mod tests {
    use std::time::SystemTime;

    use super::*;
    use crate::db::logged_requests::test_support::forwarded_request;
    use crate::db::SqliteRequestLogStore;

    /// Recording a batch that takes the unverified rows past their cap evicts
    /// exactly the overflow, and leaves the verified rows alone.
    #[test]
    fn recording_trims_each_class_to_its_cap() {
        let store = SqliteRequestLogStore::open_in_memory().expect("store");
        let now = SystemTime::now();
        let unverified_cap = usize::try_from(UNVERIFIED_CALLER_ROW_CAP).expect("cap fits");
        let full_class: Vec<ForwardedRequest> = (0..unverified_cap)
            .map(|_| forwarded_request(None, now))
            .collect();
        // Seeded in chunks: one insert binds every column of every row, and
        // SQLite caps the bound values per statement.
        for chunk in full_class.chunks(1_000) {
            store.insert_requests(chunk).expect("seed");
        }

        let batch = [
            forwarded_request(None, now),
            forwarded_request(None, now),
            forwarded_request(None, now),
            forwarded_request(Some("lifting"), now),
        ];
        assert_eq!(record_requests(&store, &batch).expect("record"), 3);
        assert_eq!(
            record_requests(&store, &[forwarded_request(Some("lifting"), now)]).expect("record"),
            0,
            "the verified rows are far inside their cap"
        );
    }

    #[test]
    fn the_class_follows_the_verified_caller() {
        let now = SystemTime::now();
        assert_eq!(
            CallerClass::of(&forwarded_request(Some("lifting"), now)),
            CallerClass::Verified
        );
        assert_eq!(
            CallerClass::of(&forwarded_request(None, now)),
            CallerClass::Unverified
        );
    }
}
