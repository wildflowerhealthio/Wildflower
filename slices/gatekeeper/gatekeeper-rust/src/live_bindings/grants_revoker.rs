//! The grants bindings — where the store-generic [`GrantsReader`] / [`GrantsRevoker`]
//! capabilities meet the concrete `SqliteGatekeeperStore` and the
//! `Arc<GatekeeperState>` router state. See the [module docs](super) for the
//! binding seam.

use std::sync::Arc;

use scopes_rust::Scope;

use super::state::GatekeeperState;
use crate::db::SqliteGatekeeperStore;
use crate::domain::capabilities::access::grants::grants_revoker_scopes;
use crate::domain::capabilities::{FixedScopeCapability, GrantsRevoker};
use crate::domain::token::VerifiedClaims;

/// Revoke a standing grant (with the token-kill cascade).
pub(crate) type LiveGrantsRevoker = GrantsRevoker<SqliteGatekeeperStore>;

impl FixedScopeCapability for LiveGrantsRevoker {
    type State = Arc<GatekeeperState>;
    type Claims = VerifiedClaims;

    fn required_scopes() -> Vec<Scope> {
        grants_revoker_scopes()
    }

    fn build(state: Arc<GatekeeperState>) -> Self {
        GrantsRevoker::new(
            state.store.clone(),
            Arc::new(state.revocation_store.clone()),
        )
    }
}
