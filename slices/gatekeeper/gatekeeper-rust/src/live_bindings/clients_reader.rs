//! The clients-reader binding — where the store-generic [`ClientsReader`]
//! capability meets the concrete `SqliteGatekeeperStore` and the
//! `Arc<GatekeeperState>` router state. See the [module docs](super) for the
//! binding seam.

use std::sync::Arc;

use scopes_rust::Scope;

use super::state::GatekeeperState;
use crate::db::SqliteGatekeeperStore;
use crate::domain::capabilities::access::clients::clients_reader_scopes;
use crate::domain::capabilities::{ClientsReader, FixedScopeCapability};
use crate::domain::token::VerifiedClaims;

/// List registered clients — `Scoped<LiveClientsReader>` in the handler.
pub(crate) type LiveClientsReader = ClientsReader<SqliteGatekeeperStore>;

impl FixedScopeCapability for LiveClientsReader {
    type State = Arc<GatekeeperState>;
    type Claims = VerifiedClaims;

    fn required_scopes() -> Vec<Scope> {
        clients_reader_scopes()
    }

    fn build(state: Arc<GatekeeperState>) -> Self {
        ClientsReader::new(state.store.clone(), state.first_party_client_id.clone())
    }
}
