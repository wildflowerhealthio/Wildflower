//! The clients-disabler binding — where the store-generic [`ClientsDisabler`]
//! capability meets the concrete `SqliteGrantStore` and the
//! `Arc<AuthorizationServerState>` router state. See the [module docs](super) for the
//! binding seam.

use std::sync::Arc;

use wildflowerhealthio_scopes::Scope;

use super::state::AuthorizationServerState;
use crate::db::SqliteGrantStore;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::access::clients::clients_disabler_scopes;
use crate::domain::capabilities::{ClientsDisabler, FixedScopeCapability};
use crate::domain::token::VerifiedClaims;

/// Disable or re-enable a registered client (never disable an essential one).
pub(crate) type LiveClientsDisabler = ClientsDisabler<SqliteGrantStore>;

impl FixedScopeCapability for LiveClientsDisabler {
    type State = Arc<AuthorizationServerState>;
    type Claims = VerifiedClaims;
    type Error = AuthorizationServerError;

    fn required_scopes() -> Vec<Scope> {
        clients_disabler_scopes()
    }

    fn build(state: Arc<AuthorizationServerState>) -> Self {
        ClientsDisabler::new(state.store.clone(), state.essential_client_guard.clone())
    }
}
