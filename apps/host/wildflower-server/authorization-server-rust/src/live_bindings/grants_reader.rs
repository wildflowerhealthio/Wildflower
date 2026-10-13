//! The grants bindings — where the store-generic [`GrantsReader`] / [`GrantsRevoker`]
//! capabilities meet the concrete `SqliteGrantStore` and the
//! `Arc<AuthorizationServerState>` router state. See the [module docs](super) for the
//! binding seam.

use std::sync::Arc;

use wildflowerhealthio_scopes::Scope;

use super::state::AuthorizationServerState;
use crate::db::SqliteGrantStore;
use crate::domain::capabilities::access::grants::grants_reader_scopes;
use crate::domain::capabilities::{FixedScopeCapability, GrantsReader};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::token::VerifiedClaims;

/// Read standing grants — `Scoped<LiveGrantsReader>` in the handler.
pub(crate) type LiveGrantsReader = GrantsReader<SqliteGrantStore>;

impl FixedScopeCapability for LiveGrantsReader {
    type State = Arc<AuthorizationServerState>;
    type Claims = VerifiedClaims;
    type Error = AuthorizationServerError;

    fn required_scopes() -> Vec<Scope> {
        grants_reader_scopes()
    }

    fn build(state: Arc<AuthorizationServerState>) -> Self {
        GrantsReader::new(state.store.clone())
    }
}
