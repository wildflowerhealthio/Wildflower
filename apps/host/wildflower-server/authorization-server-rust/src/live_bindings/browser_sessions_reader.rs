//! The browser-sessions-reader binding — where the store-generic
//! [`BrowserSessionsReader`] capability meets the concrete `SqliteGrantStore`
//! and the `Arc<AuthorizationServerState>` router state. See the
//! [module docs](super) for the binding seam.

use std::sync::Arc;

use wildflowerhealthio_scopes::Scope;

use super::state::AuthorizationServerState;
use crate::db::SqliteGrantStore;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::access::browser_sessions::browser_sessions_reader_scopes;
use crate::domain::capabilities::{BrowserSessionsReader, FixedScopeCapability};
use crate::domain::token::VerifiedClaims;

/// List the live browser sessions — `Scoped<LiveBrowserSessionsReader>` in the handler.
pub(crate) type LiveBrowserSessionsReader = BrowserSessionsReader<SqliteGrantStore>;

impl FixedScopeCapability for LiveBrowserSessionsReader {
    type State = Arc<AuthorizationServerState>;
    type Claims = VerifiedClaims;
    type Error = AuthorizationServerError;

    fn required_scopes() -> Vec<Scope> {
        browser_sessions_reader_scopes()
    }

    fn build(state: Arc<AuthorizationServerState>) -> Self {
        BrowserSessionsReader::new(state.store.clone())
    }
}
