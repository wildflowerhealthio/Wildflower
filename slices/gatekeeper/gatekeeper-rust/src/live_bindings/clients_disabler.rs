//! The clients-disabler binding — where the store-generic [`ClientsDisabler`]
//! capability meets the concrete `SqliteGatekeeperStore` and the
//! `Arc<GatekeeperState>` router state. See the [module docs](super) for the
//! binding seam.

use std::sync::Arc;

use scopes_rust::Scope;

use super::state::GatekeeperState;
use crate::db::SqliteGatekeeperStore;
use crate::domain::capabilities::access::clients::clients_disabler_scopes;
use crate::domain::capabilities::{ClientsDisabler, FixedScopeCapability};
use crate::domain::token::VerifiedClaims;

/// Disable or re-enable a registered client (never the first-party host).
pub(crate) type LiveClientsDisabler = ClientsDisabler<SqliteGatekeeperStore>;

impl FixedScopeCapability for LiveClientsDisabler {
    type State = Arc<GatekeeperState>;
    type Claims = VerifiedClaims;

    fn required_scopes() -> Vec<Scope> {
        clients_disabler_scopes()
    }

    fn build(state: Arc<GatekeeperState>) -> Self {
        ClientsDisabler::new(state.store.clone(), state.first_party_client_id.clone())
    }
}
