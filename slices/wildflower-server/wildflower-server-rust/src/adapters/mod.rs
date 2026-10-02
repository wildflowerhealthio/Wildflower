//! Other slices' ports implemented against concrete stores and clients: the
//! server is the one crate that depends on both sides, so each adapter lives
//! here rather than in either slice. Mirrors `gatekeeper-rust`'s `adapters/`.
//!
//! - [`app_launch_scopes`] — apps' `AppLaunchScopes`, from gatekeeper's OAuth
//!   clients.
//! - [`health_probe`] — the tunnel's `HealthProbe`, over `reqwest`.

pub(crate) mod app_launch_scopes;
pub(crate) mod health_probe;
