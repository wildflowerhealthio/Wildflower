//! The grants bindings — where the store-generic [`GrantsReader`] / [`GrantsRevoker`]
//! capabilities meet the concrete `SqliteGatekeeperStore` and the
//! `Arc<GatekeeperState>` router state. See the [module docs](super) for the
//! binding seam.

use std::sync::Arc;

use scopes_rust::Scope;

use super::state::GatekeeperState;
use crate::db::SqliteGatekeeperStore;
use crate::domain::capabilities::grants::grants_reader_scopes;
use crate::domain::capabilities::{FixedScopeCapability, GrantsReader};
use crate::domain::token::VerifiedClaims;

/// Read standing grants — `Scoped<LiveGrantsReader>` in the handler.
pub(crate) type LiveGrantsReader = GrantsReader<SqliteGatekeeperStore>;

impl FixedScopeCapability for LiveGrantsReader {
    type State = Arc<GatekeeperState>;
    type Claims = VerifiedClaims;

    fn required_scopes() -> Vec<Scope> {
        grants_reader_scopes()
    }

    fn build(state: Arc<GatekeeperState>) -> Self {
        GrantsReader::new(state.store.clone())
    }
}
