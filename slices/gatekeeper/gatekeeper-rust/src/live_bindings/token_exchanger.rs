//! The [`LiveTokenExchanger`] binding — the `/oauth/token` flows over the
//! concrete `SqliteGatekeeperStore`. Gated by the [`AuthenticatedClient`]
//! proof its methods take rather than by scopes, so it has no `Capability`
//! impl; the token handler builds it from the state.
//!
//! [`AuthenticatedClient`]: crate::domain::authority::AuthenticatedClient

use super::state::GatekeeperState;
use crate::db::SqliteGatekeeperStore;
use crate::domain::capabilities::oauth::TokenExchanger;

/// Exchange grants for tokens — built by the `/oauth/token` handler.
pub(crate) type LiveTokenExchanger = TokenExchanger<SqliteGatekeeperStore>;

impl LiveTokenExchanger {
    /// Lift the store handle and the first-party `client_id` out of the state.
    pub(crate) fn from_state(state: &GatekeeperState) -> Self {
        TokenExchanger::new(state.store.clone(), state.first_party_client_id.clone())
    }
}
