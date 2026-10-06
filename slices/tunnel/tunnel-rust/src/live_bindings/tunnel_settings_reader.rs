//! The `FixedScopeCapability` binding — where the capability in
//! [`crate::domain::capabilities`] meets the `Arc<TunnelState>` router state.
//! The binding lifts the daemon handle out of the state (it never hands the
//! capability the whole state), so `domain/` stays free of `crate::http`.

use std::sync::Arc;

use scope_capabilities_rust::{FixedScopeCapability, ScopeClaims};
use scopes_rust::Scope;

use super::state::TunnelState;
use crate::domain::capabilities::{tunnel_settings_reader_scopes, TunnelSettingsReader};
use crate::domain::TunnelError;

impl FixedScopeCapability for TunnelSettingsReader {
    type State = Arc<TunnelState>;
    type Claims = ScopeClaims;
    type Error = TunnelError;

    fn required_scopes() -> Vec<Scope> {
        tunnel_settings_reader_scopes()
    }

    fn build(state: Arc<TunnelState>) -> Self {
        TunnelSettingsReader::new(Arc::clone(&state.daemon))
    }
}
