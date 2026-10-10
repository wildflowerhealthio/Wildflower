//! The [`RequestLogReader`] capability — the `wildflower/RequestLog.r` door to
//! the request log. Holds its `*_scopes()` mapping (read by both its binding and
//! [`grantable_request_log_scopes`](super::grantable_request_log_scopes) so
//! enforced and grantable can't drift) and its store-focused test.

use scopes_rust::{Permission, Scope, WildflowerResource};

use crate::domain::request_log::{CallerSummary, RequestLogFilter, RequestLogPage};
use crate::domain::{RequestLogError, RequestLogStore};

/// The scope gating [`RequestLogReader`] — `wildflower/RequestLog.r`. Shared by
/// the capability's `FixedScopeCapability` binding and
/// [`grantable_request_log_scopes`](super::grantable_request_log_scopes) so
/// enforced and grantable can't drift.
pub(crate) fn request_log_reader_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::RequestLog,
        Permission::READ,
    )]
}

/// Read the request log — `GET /requests/callers` and `GET /requests`. Generic
/// over the [`RequestLogStore`] port; the binding instantiates it over the
/// concrete `SqliteRequestLogStore`.
pub(crate) struct RequestLogReader<S: RequestLogStore> {
    store: S,
}

impl<S: RequestLogStore> RequestLogReader<S> {
    /// Build the reader over a store handle lifted from the state.
    pub(crate) fn new(store: S) -> Self {
        RequestLogReader { store }
    }

    /// One summary per caller: the log grouped by (caller, client address).
    ///
    /// # Errors
    ///
    /// [`RequestLogError::Infrastructure`] if the store read fails.
    pub(crate) fn caller_summaries(&self) -> Result<Vec<CallerSummary>, RequestLogError> {
        self.store.caller_summaries()
    }

    /// The page of the log `filter` selects.
    ///
    /// # Errors
    ///
    /// [`RequestLogError::Infrastructure`] if the store read fails.
    pub(crate) fn requests_page(
        &self,
        filter: &RequestLogFilter,
    ) -> Result<RequestLogPage, RequestLogError> {
        self.store.requests_page(filter)
    }
}

#[cfg(test)]
mod tests {
    use std::time::SystemTime;

    use super::*;
    use crate::db::logged_requests::test_support::forwarded_request;

    /// The reader's gated reads return what the store logged.
    #[test]
    fn reader_reads_the_logged_requests() {
        let store = crate::db::SqliteRequestLogStore::open_in_memory().expect("store");
        store
            .insert_requests(&[forwarded_request(Some("lifting"), SystemTime::now())])
            .expect("insert");
        let reader = RequestLogReader::new(store);

        assert_eq!(reader.caller_summaries().expect("callers").len(), 1);
        assert_eq!(
            reader
                .requests_page(&RequestLogFilter::default())
                .expect("page")
                .requests
                .len(),
            1
        );
    }
}
