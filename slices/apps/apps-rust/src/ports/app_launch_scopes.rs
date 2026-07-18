//! [`AppLaunchScopes`] — the host seam that resolves a **SMART** app's required
//! launch scopes. Launching a scoped app is gated in two layers (see the launch
//! handler): the static `wildflower/launch` umbrella the [`Scoped`] extractor
//! enforces, and — for a SMART app (a host-only `client_id`) — a per-app check that
//! the caller's stored grant covers the app's OAuth client's requested scopes.
//! This port resolves that per-app requirement, keeping apps-rust decoupled from
//! gatekeeper: the host wires a gatekeeper-backed adapter that maps a
//! `client_id` to its client's `allowed_scopes`; a host with no SMART client
//! directory wires [`NoAppLaunchScopes`].
//!
//! [`Scoped`]: scope_capabilities_rust::Scoped

use scopes_rust::Scope;

use crate::domain::{AppRegistration, AppsError};

/// Resolves the scopes a launch of a given app registration requires **beyond**
/// the `wildflower/launch` umbrella. Called only for a SMART app (the capability
/// short-circuits a non-SMART one to "no extra scopes"), so an implementation
/// resolves the registration's `client_id` to its OAuth client's allowed scopes.
pub trait AppLaunchScopes: Send + Sync {
    /// The extra scopes required to launch `registration` — its SMART client's
    /// allowed scopes. An empty vec means only the umbrella scope is needed.
    ///
    /// # Errors
    ///
    /// [`AppsError::Infrastructure`] if the client directory can't be reached.
    fn required_scopes(&self, registration: &AppRegistration) -> Result<Vec<Scope>, AppsError>;
}

/// A no-op [`AppLaunchScopes`] that requires no per-app scopes — every launch is
/// gated only by the `wildflower/launch` umbrella. For a host with no SMART client
/// directory, and the default in tests that don't exercise the SMART check.
pub struct NoAppLaunchScopes;

impl AppLaunchScopes for NoAppLaunchScopes {
    fn required_scopes(&self, _registration: &AppRegistration) -> Result<Vec<Scope>, AppsError> {
        Ok(Vec::new())
    }
}
