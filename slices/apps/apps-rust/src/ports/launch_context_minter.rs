//! [`LaunchContextMinter`] — the host seam that mints the SMART App Launch
//! `launch` value a **SMART** app's launch URL carries. The gatekeeper owns
//! launch contexts: it records each one against the app's OAuth `client_id` and
//! consumes it, single-use, at the app's `/oauth/authorize`. The host wires a
//! gatekeeper-backed adapter, so apps-rust never touches the gatekeeper's
//! store.

use crate::domain::AppsError;

/// Mints a launch context for an app's OAuth client.
pub trait LaunchContextMinter: Send + Sync {
    /// Mint a launch for the OAuth client `client_id` and return its `launch`
    /// value. The launch handler calls this for a SMART app only, after the
    /// caller has passed the launch gates and before it hands back the launch
    /// URL.
    ///
    /// # Errors
    ///
    /// [`AppsError::Infrastructure`] if the launch can't be recorded.
    fn mint_launch_context(&self, client_id: &str) -> Result<String, AppsError>;
}
