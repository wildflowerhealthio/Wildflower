//! The [`LiveTokenExchanger`] binding — the `/oauth/token` flows over the
//! concrete `SqliteGatekeeperStore`. Gated by the [`AuthenticatedClient`]
//! proof its methods take rather than by scopes, so it has no `Capability`
//! impl; the token handler acquires it through `Live<…>`.
//!
//! [`AuthenticatedClient`]: crate::domain::authority::AuthenticatedClient

use std::sync::Arc;

use super::state::GatekeeperState;
use super::FromState;
use crate::db::SqliteGatekeeperStore;
use crate::domain::capabilities::oauth::TokenExchanger;

/// Exchange grants for tokens — built by the `/oauth/token` handler.
pub(crate) type LiveTokenExchanger = TokenExchanger<SqliteGatekeeperStore>;

impl FromState for LiveTokenExchanger {
    fn from_state(state: &Arc<GatekeeperState>) -> Self {
        TokenExchanger::new(state.store.clone())
    }
}
