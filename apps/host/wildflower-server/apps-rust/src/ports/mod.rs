//! Host-seam **dependency-inversion** traits — the ports the apps HTTP layer
//! calls out through and the host wires concrete implementations into
//! [`AppsState`](crate::live_bindings::state::AppsState):
//!
//!  - [`launch_context_minter::LaunchContextMinter`] — mints the SMART `launch`
//!    value a SMART app's launch URL carries (authorization-server-backed host-side).
//!
//! Keeping them here (rather than beside the routes) marks them as seams: pure
//! traits with no apps-slice logic, so apps-rust never learns the authorization server
//! token format.

pub mod launch_context_minter;

pub use launch_context_minter::LaunchContextMinter;
