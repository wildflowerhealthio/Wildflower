//! The [`LiveAppLauncher`] binding — the launch capability, gated by the
//! `wildflower/launch` umbrella. See the [module docs](super) for the binding
//! seam.

use std::sync::Arc;

use wildflowerhealthio_scope_capabilities::{FixedScopeCapability, ScopeClaims};
use wildflowerhealthio_scopes::Scope;

use super::state::AppsState;
use crate::domain::capabilities::{app_launcher_scopes, AppLauncher};
use crate::domain::AppsError;

/// Launch a scoped app — `Scoped<LiveAppLauncher>` in the launch handler.
pub(crate) type LiveAppLauncher = AppLauncher;

impl FixedScopeCapability for LiveAppLauncher {
    type State = Arc<AppsState>;
    type Claims = ScopeClaims;
    type Error = AppsError;

    fn required_scopes() -> Vec<Scope> {
        app_launcher_scopes()
    }

    fn build(_state: Arc<AppsState>) -> Self {
        AppLauncher
    }
}
