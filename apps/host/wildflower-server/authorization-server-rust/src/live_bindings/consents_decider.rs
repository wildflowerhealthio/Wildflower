//! The consent bindings — where the store-generic [`ConsentReader`] /
//! [`ConsentDecider`] capabilities meet the concrete `SqliteGatekeeperStore` and
//! the `Arc<AuthorizationServerState>` router state. [`LiveConsentDecider`] is the
//! variable-scope flavour ([`Capability`], built with the caller's [`Grant`]);
//! [`LiveConsentReader`] is fixed-scope. See the [module docs](super) for the
//! binding seam.

use std::sync::Arc;

use wildflowerhealthio_scopes::{Grant, Scope};

use super::state::AuthorizationServerState;
use crate::db::SqliteGatekeeperStore;
use crate::domain::capabilities::access::consents::consent_decider_scopes;
use crate::domain::capabilities::{Capability, ConsentDecider};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::token::VerifiedClaims;
use crate::ports::PendingConsentPublisher;

/// Decide (approve/deny) pending consent prompts.
pub(crate) type LiveConsentDecider = ConsentDecider<SqliteGatekeeperStore>;

impl Capability for LiveConsentDecider {
    type State = Arc<AuthorizationServerState>;
    type Claims = VerifiedClaims;
    type Error = AuthorizationServerError;

    fn required_scopes() -> Vec<Scope> {
        consent_decider_scopes()
    }

    fn build(state: Arc<AuthorizationServerState>, granted: Grant) -> Self {
        // `Arc<AuthorizationServerState>` implements `PendingConsentPublisher` (via the bare
        // state's impl), so it coerces to the port handle the capability holds.
        let publisher: Arc<dyn PendingConsentPublisher> = state.clone();
        ConsentDecider::new(
            state.store.clone(),
            publisher,
            granted,
            state.first_party_client_id.clone(),
        )
    }
}
