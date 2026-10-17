//! The [`LiveTokenExchanger`] binding — the `/oauth/token` flows over the
//! concrete `SqliteGrantStore`. Gated by the [`AuthenticatedClient`]
//! proof its methods take rather than by scopes, so it has no `Capability`
//! impl; the token handler acquires it through `Live<…>`.
//!
//! [`AuthenticatedClient`]: crate::domain::authority::AuthenticatedClient

use std::sync::Arc;

use super::state::AuthorizationServerState;
use super::FromState;
use crate::db::SqliteGrantStore;
use crate::domain::capabilities::oauth::TokenExchanger;

/// Exchange grants for tokens — built by the `/oauth/token` handler.
pub(crate) type LiveTokenExchanger = TokenExchanger<SqliteGrantStore>;

impl FromState for LiveTokenExchanger {
    fn from_state(state: &Arc<AuthorizationServerState>) -> Self {
        TokenExchanger::new(
            state.store.clone(),
            state.revocation_check(),
            state.server_origin.clone(),
        )
    }
}
