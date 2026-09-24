//! Host-seam **dependency-inversion** traits — the ports the apps HTTP layer
//! calls out through and the host wires concrete implementations into
//! [`AppsState`](crate::live_bindings::state::AppsState):
//!
//!  - [`app_launch_scopes::AppLaunchScopes`] — resolves a SMART app's per-app
//!    launch scopes (its OAuth client's allowed scopes, gatekeeper-backed
//!    host-side) for the per-app launch check.
//!
//! Keeping them here (rather than beside the routes) marks them as seams: pure
//! traits with no apps-slice logic, so apps-rust never learns the gatekeeper
//! token format.
//!
//! (The loopback launch's owner gate — the former `owner_auth` port — was retired
//! once the `wildflower/launch` scope gate covered the launch surface.)

pub mod app_launch_scopes;

pub use app_launch_scopes::{AppLaunchScopes, NoAppLaunchScopes};
