//! The request log: what the trusted front relayed through the tunnel, kept on
//! the device. The [`RequestLogStore`] port, the row caps that bound it, and
//! [`record_requests`], the action the request-log writer runs on each batch.
//! Its time-based retention is [`crate::domain::retention`].
//!
//! Each row is a [`ForwardedRequest`] the server's forwarded-request layer
//! reported. The record holds no record identifiers (its path is reduced to the
//! route), and the client's display name is not stored: readers resolve it from
//! the `client_id` through gatekeeper.

use shared_structures_rust::request_caller::ForwardedRequest;

use crate::domain::TunnelError;

/// The most rows kept for requests that carried a verified caller.
pub const VERIFIED_CALLER_ROW_CAP: i64 = 100_000;

/// The most rows kept for requests no bearer gate verified: ungated, or refused
/// with a `401`. Separate from [`VERIFIED_CALLER_ROW_CAP`] so a flood of
/// refused requests only evicts other refused requests.
pub const UNVERIFIED_CALLER_ROW_CAP: i64 = 20_000;

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

/// The persistence port for the request log, beside
/// [`TunnelStore`](crate::domain::TunnelStore) on the same `SQLite` adapter.
/// Rows are numbered in arrival order, so a higher id is a newer request.
pub trait RequestLogStore {
    /// Append `requests`, oldest first, in one insert.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / insert failure.
    fn insert_requests(&self, requests: &[ForwardedRequest]) -> Result<(), TunnelError>;

    /// Delete `caller_class`'s rows at least `row_cap` ids behind its newest
    /// one, oldest first, returning how many went. An id-range delete within
    /// the class: the class keeps at most `row_cap` rows (fewer while the other
    /// class's rows sit between them), and the other class is untouched.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / delete failure.
    fn delete_requests_beyond_cap(
        &self,
        caller_class: CallerClass,
        row_cap: i64,
    ) -> Result<usize, TunnelError>;

    /// Delete every row received before `cutoff`, returning how many went.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / delete failure.
    fn delete_requests_received_before(
        &self,
        cutoff: chrono::DateTime<chrono::Utc>,
    ) -> Result<usize, TunnelError>;
}

/// Append `requests` to the log, then trim each class back to its row cap,
/// returning how many rows the caps evicted.
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] if the insert or a trim fails. A failed trim
/// leaves the batch inserted; the next batch's trim catches up.
pub fn record_requests(
    store: &impl RequestLogStore,
    requests: &[ForwardedRequest],
) -> Result<usize, TunnelError> {
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
    use crate::db::tunnel_requests::test_support::forwarded_request;
    use crate::db::SqliteTunnelStore;

    /// Recording a batch that takes the unverified rows past their cap evicts
    /// exactly the overflow, and leaves the verified rows alone.
    #[test]
    fn recording_trims_each_class_to_its_cap() {
        let store = SqliteTunnelStore::open_in_memory().expect("store");
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
