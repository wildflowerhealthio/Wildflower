//! Other slices' ports implemented against concrete stores and clients: the
//! server is the one crate that depends on both sides, so each adapter lives
//! here rather than in either slice. Mirrors `authorization-server-rust`'s `adapters/`.
//! The server's own certificate, over rustls-acme, is here too.
//!
//! - [`access_token_verifier`] — fhir-r4's `AccessTokenVerifier`, from the
//!   authorization server's token verifier.
//! - [`acme_certificate`] — the tunnel listener's device certificate, ordered
//!   from an ACME CA and renewed by rustls-acme, and the state a run publishes
//!   and a stopped server's cache holds.
//! - [`certificate_history`] — each server's history of the certificates its
//!   runs deployed, a JSON file beside its certificate cache.
//! - [`authorization_start_limit`] — the authorization server's
//!   `AuthorizationStartGate`: how fast tunnel visitors may start
//!   authorization requests, each and all together.
//! - [`app_launch_scopes`] — apps' `AppLaunchScopes`, from the authorization server's OAuth
//!   clients.
//! - [`health_probe`] — the reachability monitor's `HealthProbe`, over
//!   `reqwest`.
//! - [`launch_context_minter`] — apps' `LaunchContextMinter`, from the authorization server's
//!   launch contexts.

pub(crate) mod access_token_verifier;
pub(crate) mod acme_certificate;
pub(crate) mod app_launch_scopes;
pub(crate) mod authorization_start_limit;
pub(crate) mod certificate_history;
pub(crate) mod health_probe;
pub(crate) mod launch_context_minter;
