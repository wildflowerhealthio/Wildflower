//! The host's [`wildflowerhealthio_apps::ports::LaunchContextMinter`], backed by gatekeeper's
//! launch contexts.

use wildflowerhealthio_apps::domain::AppsError;
use wildflowerhealthio_apps::ports::LaunchContextMinter;

/// The host's [`wildflowerhealthio_apps::ports::LaunchContextMinter`]: mints each SMART app
/// launch's `launch` value through gatekeeper's
/// [`wildflowerhealthio_authorization_server::LaunchContextMinter`], so the app's `/oauth/authorize`
/// can consume it.
pub(crate) struct AuthorizationServerLaunchContextMinter {
    pub(crate) launch_context_minter: wildflowerhealthio_authorization_server::LaunchContextMinter,
}

impl LaunchContextMinter for AuthorizationServerLaunchContextMinter {
    fn mint_launch_context(&self, client_id: &str) -> Result<String, AppsError> {
        self.launch_context_minter
            .mint(client_id)
            .map_err(|error| AppsError::infrastructure("mint a SMART app launch", error))
    }
}
