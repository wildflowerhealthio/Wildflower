//! The `FixedScopeCapability` bindings — where the generic, store-agnostic
//! capabilities in [`crate::domain::capabilities`] meet the concrete
//! [`SqliteTunnelStore`] and the `Arc<TunnelState>` router state. Each binding
//! lifts the store + daemon handles out of the state (it never hands the
//! capability the whole state), so `domain/` stays free of both `crate::http`
//! and the concrete adapter types. The `type …Cap` aliases are what the
//! `/tunnel` handlers name in `Scoped<…>`.

use std::sync::Arc;

use scope_capabilities_rust::{FixedScopeCapability, ScopeClaims};
use scopes_rust::Scope;

use super::state::TunnelState;
use crate::db::SqliteTunnelStore;
use crate::domain::capabilities::{tunnel_settings_reader_scopes, TunnelSettingsReader};

/// Read the tunnel settings — `Scoped<LiveTunnelSettingsReader>` in the handler.
pub(crate) type LiveTunnelSettingsReader = TunnelSettingsReader<SqliteTunnelStore>;

impl FixedScopeCapability for LiveTunnelSettingsReader {
    type State = Arc<TunnelState>;
    type Claims = ScopeClaims;

    fn required_scopes() -> Vec<Scope> {
        tunnel_settings_reader_scopes()
    }

    fn build(state: Arc<TunnelState>) -> Self {
        TunnelSettingsReader::new(state.store.clone(), Arc::clone(&state.daemon))
    }
}
