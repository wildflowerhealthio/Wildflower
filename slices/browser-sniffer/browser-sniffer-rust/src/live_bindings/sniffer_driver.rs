//! The [`SnifferDriver`](crate::domain::capabilities::SnifferDriver) binding —
//! drives the sniffer through the host handle held by the state. See the
//! [module docs](super) for the binding seam.

use std::sync::Arc;

use scope_capabilities_rust::{FixedScopeCapability, ScopeClaims};
use scopes_rust::Scope;

use super::state::SnifferState;
use crate::domain::capabilities::{sniffer_driver_scopes, SnifferDriver};

impl FixedScopeCapability for SnifferDriver {
    type State = Arc<SnifferState>;
    type Claims = ScopeClaims;

    fn required_scopes() -> Vec<Scope> {
        sniffer_driver_scopes()
    }

    fn build(state: Arc<SnifferState>) -> Self {
        SnifferDriver::new(Arc::clone(&state.handle))
    }
}
