//! The consent bindings — where the store-generic [`ConsentReader`] /
//! [`ConsentDecider`] capabilities meet the concrete `SqliteGatekeeperStore` and
//! the `Arc<GatekeeperState>` router state. [`LiveConsentDecider`] is the
//! variable-scope flavour ([`Capability`], built with the caller's [`Grant`]);
//! [`LiveConsentReader`] is fixed-scope. See the [module docs](super) for the
//! binding seam.

use std::sync::Arc;

use wildflowerhealthio_scopes::{Grant, Scope};

use super::state::GatekeeperState;
use crate::db::SqliteGatekeeperStore;
use crate::domain::capabilities::access::consents::consent_decider_scopes;
use crate::domain::capabilities::{Capability, ConsentDecider};
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::token::VerifiedClaims;
use crate::ports::PendingConsentPublisher;

/// Decide (approve/deny) pending consent prompts.
pub(crate) type LiveConsentDecider = ConsentDecider<SqliteGatekeeperStore>;

impl Capability for LiveConsentDecider {
    type State = Arc<GatekeeperState>;
    type Claims = VerifiedClaims;
    type Error = GatekeeperError;

    fn required_scopes() -> Vec<Scope> {
        consent_decider_scopes()
    }

    fn build(state: Arc<GatekeeperState>, granted: Grant) -> Self {
        // `Arc<GatekeeperState>` implements `PendingConsentPublisher` (via the bare
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
