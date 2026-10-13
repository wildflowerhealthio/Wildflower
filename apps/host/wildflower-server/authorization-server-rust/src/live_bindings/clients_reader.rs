//! The clients-reader binding — where the store-generic [`ClientsReader`]
//! capability meets the concrete `SqliteGrantStore` and the
//! `Arc<AuthorizationServerState>` router state. See the [module docs](super) for the
//! binding seam.

use std::sync::Arc;

use wildflowerhealthio_scopes::Scope;

use super::state::AuthorizationServerState;
use crate::db::SqliteGrantStore;
use crate::domain::capabilities::access::clients::clients_reader_scopes;
use crate::domain::capabilities::{ClientsReader, FixedScopeCapability};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::token::VerifiedClaims;

/// List registered clients — `Scoped<LiveClientsReader>` in the handler.
pub(crate) type LiveClientsReader = ClientsReader<SqliteGrantStore>;

impl FixedScopeCapability for LiveClientsReader {
    type State = Arc<AuthorizationServerState>;
    type Claims = VerifiedClaims;
    type Error = AuthorizationServerError;

    fn required_scopes() -> Vec<Scope> {
        clients_reader_scopes()
    }

    fn build(state: Arc<AuthorizationServerState>) -> Self {
        ClientsReader::new(state.store.clone(), state.first_party_client_id.clone())
    }
}
