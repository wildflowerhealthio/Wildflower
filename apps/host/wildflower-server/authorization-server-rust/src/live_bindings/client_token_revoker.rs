//! The [`LiveClientTokenRevoker`] binding — `/oauth/revoke` over the concrete
//! `SqliteGrantStore`. Gated by the [`AuthenticatedClient`] proof its method
//! takes rather than by scopes, so it has no `Capability` impl; the revocation
//! handler acquires it through `Live<…>`.
//!
//! [`AuthenticatedClient`]: crate::domain::authority::AuthenticatedClient

use std::sync::Arc;

use super::state::AuthorizationServerState;
use super::FromState;
use crate::db::SqliteGrantStore;
use crate::domain::capabilities::oauth::ClientTokenRevoker;

/// Revoke a client's own tokens — built by the `/oauth/revoke` handler.
pub(crate) type LiveClientTokenRevoker = ClientTokenRevoker<SqliteGrantStore>;

impl FromState for LiveClientTokenRevoker {
    fn from_state(state: &Arc<AuthorizationServerState>) -> Self {
        ClientTokenRevoker::new(
            state.store.clone(),
            state.revocation(),
            state.server_origin.clone(),
        )
    }
}
