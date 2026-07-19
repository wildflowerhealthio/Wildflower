//! The [`LiveAppLauncher`] binding — the **hybrid** launch capability. It
//! implements [`Capability`] directly (not `FixedScopeCapability`) so its builder
//! can stash the caller's [`Grant`] for the per-app SMART check, while still
//! declaring the static `wildflower/launch` umbrella the `Scoped` extractor
//! enforces before `build`. See the [module docs](super) for the binding seam.

use std::sync::Arc;

use scope_capabilities_rust::{Capability, ScopeClaims};
use scopes_rust::{Grant, Scope};

use super::state::AppsState;
use crate::domain::capabilities::{app_launcher_scopes, AppLauncher};

/// Launch a scoped app — `Scoped<LiveAppLauncher>` in the launch handler.
pub(crate) type LiveAppLauncher = AppLauncher;

impl Capability for LiveAppLauncher {
    type State = Arc<AppsState>;
    type Claims = ScopeClaims;

    fn required_scopes() -> Vec<Scope> {
        app_launcher_scopes()
    }

    fn build(state: Arc<AppsState>, granted: Grant) -> Self {
        AppLauncher::new(granted, Arc::clone(&state.launch_scopes))
    }
}
