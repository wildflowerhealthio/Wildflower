//! The grants bindings — where the store-generic [`GrantsReader`] / [`GrantsRevoker`]
//! capabilities meet the concrete `SqliteGrantStore` and the
//! `Arc<AuthorizationServerState>` router state. See the [module docs](super) for the
//! binding seam.

use std::sync::Arc;

use wildflowerhealthio_scopes::Scope;

use super::state::AuthorizationServerState;
use crate::db::SqliteGrantStore;
use crate::domain::capabilities::access::grants::grants_revoker_scopes;
use crate::domain::capabilities::{FixedScopeCapability, GrantsRevoker};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::token::VerifiedClaims;

/// Revoke a standing grant (with the token-kill cascade).
pub(crate) type LiveGrantsRevoker = GrantsRevoker<SqliteGrantStore>;

impl FixedScopeCapability for LiveGrantsRevoker {
    type State = Arc<AuthorizationServerState>;
    type Claims = VerifiedClaims;
    type Error = AuthorizationServerError;

    fn required_scopes() -> Vec<Scope> {
        grants_revoker_scopes()
    }

    fn build(state: Arc<AuthorizationServerState>) -> Self {
        GrantsRevoker::new(
            state.store.clone(),
            Arc::new(state.revocation_store.clone()),
        )
    }
}
