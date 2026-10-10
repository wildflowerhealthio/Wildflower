//! The host's [`apps_rust::ports::AppLaunchScopes`], backed by gatekeeper's
//! OAuth clients.

use apps_rust::ports::AppLaunchScopes;
use gatekeeper_rust::client_allowed_scopes;

/// The host's [`apps_rust::ports::AppLaunchScopes`]: resolves a **SMART** app's
/// `client_id` to its OAuth client's allowed scopes (via
/// [`gatekeeper_rust::client_allowed_scopes`], which reads inside the opaque
/// `GatekeeperState`), so the apps launch handler can require the launching
/// caller's grant to cover them. A non-SMART app (no `client_id`) needs no per-app
/// scopes — only the `wildflower/launch` umbrella.
#[derive(Clone)]
pub(crate) struct GatekeeperAppLaunchScopes {
    pub(crate) state: std::sync::Arc<gatekeeper_rust::GatekeeperState>,
}

impl AppLaunchScopes for GatekeeperAppLaunchScopes {
    fn required_scopes(
        &self,
        registration: &apps_rust::AppRegistration,
    ) -> Result<Vec<scopes_rust::Scope>, apps_rust::domain::AppsError> {
        // The capability only calls this for a SMART app, but stay defensive.
        let Some(client_id) = registration.client_id.as_deref() else {
            return Ok(Vec::new());
        };
        client_allowed_scopes(&self.state, client_id).map_err(|error| {
            apps_rust::domain::AppsError::infrastructure("resolve SMART app launch scopes", error)
        })
    }
}
