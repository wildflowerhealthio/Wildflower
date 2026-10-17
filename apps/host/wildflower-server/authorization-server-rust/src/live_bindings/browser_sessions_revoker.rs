//! The browser-sessions-revoker binding — where the store-generic
//! [`BrowserSessionsRevoker`] capability meets the concrete `SqliteGrantStore`
//! and the `Arc<AuthorizationServerState>` router state. See the
//! [module docs](super) for the binding seam.

use std::sync::Arc;

use wildflowerhealthio_scopes::Scope;

use super::state::AuthorizationServerState;
use crate::db::SqliteGrantStore;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::access::browser_sessions::browser_sessions_revoker_scopes;
use crate::domain::capabilities::{BrowserSessionsRevoker, FixedScopeCapability};
use crate::domain::token::VerifiedClaims;

/// Revoke a browser session — `Scoped<LiveBrowserSessionsRevoker>` in the handler.
pub(crate) type LiveBrowserSessionsRevoker = BrowserSessionsRevoker<SqliteGrantStore>;

impl FixedScopeCapability for LiveBrowserSessionsRevoker {
    type State = Arc<AuthorizationServerState>;
    type Claims = VerifiedClaims;
    type Error = AuthorizationServerError;

    fn required_scopes() -> Vec<Scope> {
        browser_sessions_revoker_scopes()
    }

    fn build(state: Arc<AuthorizationServerState>) -> Self {
        BrowserSessionsRevoker::new(state.store.clone())
    }
}
