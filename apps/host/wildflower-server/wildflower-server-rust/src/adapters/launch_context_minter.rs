//! The host's [`apps_rust::ports::LaunchContextMinter`], backed by gatekeeper's
//! launch contexts.

use apps_rust::domain::AppsError;
use apps_rust::ports::LaunchContextMinter;

/// The host's [`apps_rust::ports::LaunchContextMinter`]: mints each SMART app
/// launch's `launch` value through gatekeeper's
/// [`gatekeeper_rust::LaunchContextMinter`], so the app's `/oauth/authorize`
/// can consume it.
pub(crate) struct GatekeeperLaunchContextMinter {
    pub(crate) launch_context_minter: gatekeeper_rust::LaunchContextMinter,
}

impl LaunchContextMinter for GatekeeperLaunchContextMinter {
    fn mint_launch_context(&self, client_id: &str) -> Result<String, AppsError> {
        self.launch_context_minter
            .mint(client_id)
            .map_err(|error| AppsError::infrastructure("mint a SMART app launch", error))
    }
}
