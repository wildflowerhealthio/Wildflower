//! The host's [`wildflowerhealthio_apps::ports::AppLaunchScopes`], backed by gatekeeper's
//! OAuth clients.

use wildflowerhealthio_apps::ports::AppLaunchScopes;
use wildflowerhealthio_gatekeeper::client_allowed_scopes;

/// The host's [`wildflowerhealthio_apps::ports::AppLaunchScopes`]: resolves a **SMART** app's
/// `client_id` to its OAuth client's allowed scopes (via
/// [`wildflowerhealthio_gatekeeper::client_allowed_scopes`], which reads inside the opaque
/// `GatekeeperState`), so the apps launch handler can require the launching
/// caller's grant to cover them. A non-SMART app (no `client_id`) needs no per-app
/// scopes — only the `wildflower/launch` umbrella.
#[derive(Clone)]
pub(crate) struct GatekeeperAppLaunchScopes {
    pub(crate) state: std::sync::Arc<wildflowerhealthio_gatekeeper::GatekeeperState>,
}

impl AppLaunchScopes for GatekeeperAppLaunchScopes {
    fn required_scopes(
        &self,
        registration: &wildflowerhealthio_apps::AppRegistration,
    ) -> Result<Vec<wildflowerhealthio_scopes::Scope>, wildflowerhealthio_apps::domain::AppsError>
    {
        // The capability only calls this for a SMART app, but stay defensive.
        let Some(client_id) = registration.client_id.as_deref() else {
            return Ok(Vec::new());
        };
        client_allowed_scopes(&self.state, client_id).map_err(|error| {
            wildflowerhealthio_apps::domain::AppsError::infrastructure(
                "resolve SMART app launch scopes",
                error,
            )
        })
    }
}
