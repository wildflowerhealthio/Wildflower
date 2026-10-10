//! Other slices' ports implemented against concrete stores and clients: the
//! server is the one crate that depends on both sides, so each adapter lives
//! here rather than in either slice. Mirrors `gatekeeper-rust`'s `adapters/`.
//! The server's own certificate, over rustls-acme, is here too.
//!
//! - [`acme_certificate`] — the tunnel listener's device certificate, ordered
//!   from an ACME CA and renewed by rustls-acme, and the state a run publishes
//!   and a stopped server's cache holds.
//! - [`certificate_history`] — each server's history of the certificates its
//!   runs deployed, a JSON file beside its certificate cache.
//! - [`app_launch_scopes`] — apps' `AppLaunchScopes`, from gatekeeper's OAuth
//!   clients.
//! - [`health_probe`] — the reachability monitor's `HealthProbe`, over
//!   `reqwest`.
//! - [`launch_context_minter`] — apps' `LaunchContextMinter`, from gatekeeper's
//!   launch contexts.

pub(crate) mod acme_certificate;
pub(crate) mod app_launch_scopes;
pub(crate) mod certificate_history;
pub(crate) mod health_probe;
pub(crate) mod launch_context_minter;
