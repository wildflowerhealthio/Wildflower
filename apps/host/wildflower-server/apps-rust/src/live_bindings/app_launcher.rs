//! The [`LiveAppLauncher`] binding — the **hybrid** launch capability. Unlike the
//! fixed-scope bindings beside it, it implements [`Capability`] directly so its
//! builder can store the caller's [`Grant`] for the per-app SMART check, while
//! still declaring the static `wildflower/launch` umbrella the `Scoped` extractor
//! enforces before `build`. See the [module docs](super) for the binding seam.

use std::sync::Arc;

use wildflowerhealthio_scope_capabilities::{Capability, ScopeClaims};
use wildflowerhealthio_scopes::{Grant, Scope};

use super::state::AppsState;
use crate::domain::capabilities::{app_launcher_scopes, AppLauncher};
use crate::domain::AppsError;

/// Launch a scoped app — the hybrid umbrella + per-app SMART capability;
/// `Scoped<LiveAppLauncher>` in the launch handlers.
pub(crate) type LiveAppLauncher = AppLauncher;

impl Capability for LiveAppLauncher {
    type State = Arc<AppsState>;
    type Claims = ScopeClaims;
    type Error = AppsError;

    fn required_scopes() -> Vec<Scope> {
        app_launcher_scopes()
    }

    fn build(state: Arc<AppsState>, granted: Grant) -> Self {
        AppLauncher::new(granted, Arc::clone(&state.launch_scopes))
    }
}
