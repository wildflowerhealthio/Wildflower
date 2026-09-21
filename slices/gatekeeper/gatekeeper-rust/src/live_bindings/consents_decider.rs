//! The consent bindings — where the store-generic [`ConsentReader`] /
//! [`ConsentDecider`] capabilities meet the concrete `SqliteGatekeeperStore` and
//! the `Arc<GatekeeperState>` router state. [`LiveConsentDecider`] is the
//! variable-scope flavour ([`Capability`], built with the caller's [`Grant`]);
//! [`LiveConsentReader`] is fixed-scope. See the [module docs](super) for the
//! binding seam.

use std::sync::Arc;

use scopes_rust::{Grant, Scope};

use super::state::GatekeeperState;
use crate::db::SqliteGatekeeperStore;
use crate::domain::capabilities::consents::consent_decider_scopes;
use crate::domain::capabilities::{Capability, ConsentDecider};
use crate::domain::token::VerifiedClaims;
use crate::ports::DeviceUserCodePublisher;

/// Decide (approve/deny) pending consent prompts.
pub(crate) type LiveConsentDecider = ConsentDecider<SqliteGatekeeperStore>;

impl Capability for LiveConsentDecider {
    type State = Arc<GatekeeperState>;
    type Claims = VerifiedClaims;

    fn required_scopes() -> Vec<Scope> {
        consent_decider_scopes()
    }

    fn build(state: Arc<GatekeeperState>, granted: Grant) -> Self {
        // `Arc<GatekeeperState>` implements `DeviceUserCodePublisher` (via the bare
        // state's impl), so it coerces to the port handle the capability holds.
        let publisher: Arc<dyn DeviceUserCodePublisher> = state.clone();
        ConsentDecider::new(
            state.store.clone(),
            publisher,
            granted,
            state.self_hosted_redirects.clone(),
            state.first_party_client_id.clone(),
        )
    }
}
