//! The `FixedScopeCapability` binding for [`RequestLogReader`] over the
//! concrete [`SqliteTunnelStore`] — see the sibling `tunnel_settings_reader`
//! binding for the pattern. The `type Live…` alias is what the request-log
//! handlers name in `Scoped<…>`.

use std::sync::Arc;

use scope_capabilities_rust::{FixedScopeCapability, ScopeClaims};
use scopes_rust::Scope;

use super::state::TunnelState;
use crate::db::SqliteTunnelStore;
use crate::domain::capabilities::{request_log_reader_scopes, RequestLogReader};

/// Read the request log — `Scoped<LiveRequestLogReader>` in the handlers.
pub(crate) type LiveRequestLogReader = RequestLogReader<SqliteTunnelStore>;

impl FixedScopeCapability for LiveRequestLogReader {
    type State = Arc<TunnelState>;
    type Claims = ScopeClaims;

    fn required_scopes() -> Vec<Scope> {
        request_log_reader_scopes()
    }

    fn build(state: Arc<TunnelState>) -> Self {
        RequestLogReader::new(state.store.clone())
    }
}
