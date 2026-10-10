//! The [`LiveRequestLogReader`] binding — reads the request log through the
//! concrete `SqliteRequestLogStore`. See the [module docs](super) for the
//! binding seam.

use std::sync::Arc;

use scope_capabilities_rust::{FixedScopeCapability, ScopeClaims};
use scopes_rust::Scope;

use super::state::RequestLogState;
use crate::db::SqliteRequestLogStore;
use crate::domain::capabilities::{request_log_reader_scopes, RequestLogReader};
use crate::domain::RequestLogError;

/// Read the request log — `Scoped<LiveRequestLogReader>` in the handlers.
pub(crate) type LiveRequestLogReader = RequestLogReader<SqliteRequestLogStore>;

impl FixedScopeCapability for LiveRequestLogReader {
    type State = Arc<RequestLogState>;
    type Claims = ScopeClaims;
    type Error = RequestLogError;

    fn required_scopes() -> Vec<Scope> {
        request_log_reader_scopes()
    }

    fn build(state: Arc<RequestLogState>) -> Self {
        RequestLogReader::new(state.store.clone())
    }
}
