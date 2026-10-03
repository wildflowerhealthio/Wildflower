//! The [`RequestLogReader`] capability — the door to the request log, gated by
//! the same `wildflower/TunnelSettings.r` as the settings read. Holds its
//! `*_scopes()` mapping (read by both its binding and
//! [`grantable_tunnel_scopes`](super::grantable_tunnel_scopes) so enforced and
//! grantable can't drift) and its store-focused test.

use scopes_rust::Scope;

use super::tunnel_settings_reader_scopes;
use crate::domain::request_log::{RequestActivity, RequestLogFilter, RequestLogPage};
use crate::domain::{RequestLogStore, TunnelError};

/// The scope gating [`RequestLogReader`]: the tunnel settings read scope
/// ([`tunnel_settings_reader_scopes`]), since who reached the server through
/// the tunnel is part of what the tunnel settings page shows.
pub(crate) fn request_log_reader_scopes() -> Vec<Scope> {
    tunnel_settings_reader_scopes()
}

/// Read the request log — `GET /tunnel/activity` and `GET /tunnel/requests`.
/// Generic over the [`RequestLogStore`] port; the binding instantiates it over
/// the concrete `SqliteTunnelStore`. A capability of its own rather than a
/// method on [`TunnelSettingsReader`](super::TunnelSettingsReader), which reads
/// the settings port.
pub(crate) struct RequestLogReader<S: RequestLogStore> {
    store: S,
}

impl<S: RequestLogStore> RequestLogReader<S> {
    /// Build the reader over a store handle lifted from the state.
    pub(crate) fn new(store: S) -> Self {
        RequestLogReader { store }
    }

    /// The activity feed: the log grouped by (caller, client address).
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] if the store read fails.
    pub(crate) fn activity(&self) -> Result<Vec<RequestActivity>, TunnelError> {
        self.store.request_activity()
    }

    /// The page of the log `filter` selects.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] if the store read fails.
    pub(crate) fn requests_page(
        &self,
        filter: &RequestLogFilter,
    ) -> Result<RequestLogPage, TunnelError> {
        self.store.requests_page(filter)
    }
}

#[cfg(test)]
mod tests {
    use std::time::SystemTime;

    use super::*;
    use crate::db::tunnel_requests::test_support::forwarded_request;

    /// The reader's gated reads return what the store logged.
    #[test]
    fn reader_reads_the_logged_requests() {
        let store = crate::db::SqliteTunnelStore::open_in_memory().expect("store");
        store
            .insert_requests(&[forwarded_request(Some("lifting"), SystemTime::now())])
            .expect("insert");
        let reader = RequestLogReader::new(store);

        assert_eq!(reader.activity().expect("activity").len(), 1);
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
