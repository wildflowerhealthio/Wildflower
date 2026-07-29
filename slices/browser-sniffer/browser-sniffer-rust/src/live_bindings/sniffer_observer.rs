//! The [`SnifferObserver`](crate::domain::capabilities::SnifferObserver)
//! binding — subscribes to the event stream held by the state. See the
//! [module docs](super) for the binding seam.

use std::sync::Arc;

use scope_capabilities_rust::{FixedScopeCapability, ScopeClaims};
use scopes_rust::Scope;

use super::state::SnifferState;
use crate::domain::capabilities::{sniffer_observer_scopes, SnifferObserver};

impl FixedScopeCapability for SnifferObserver {
    type State = Arc<SnifferState>;
    type Claims = ScopeClaims;

    fn required_scopes() -> Vec<Scope> {
        sniffer_observer_scopes()
    }

    fn build(state: Arc<SnifferState>) -> Self {
        SnifferObserver::new(state.events.clone())
    }
}
