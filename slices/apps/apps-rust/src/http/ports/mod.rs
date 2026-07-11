//! Host-seam **dependency-inversion** traits — the ports the apps HTTP layer
//! calls out through and the host wires concrete implementations into
//! [`AppsState`](crate::http::AppsState):
//!
//!  - [`owner_auth::OwnerAuth`] — authorizes a loopback launch (the gatekeeper
//!    owner-bearer check host-side);
//!  - [`launch_cookies::LaunchCookies`] — re-scopes the caller's owner session
//!    onto a forwarded self-hosted app's public host (the gatekeeper cookie
//!    builder host-side).
//!
//! Keeping them here (rather than beside the routes) marks them as seams: pure
//! traits with no apps-slice logic, so apps-rust never learns the gatekeeper
//! token or cookie formats.

pub mod launch_cookies;
pub mod owner_auth;
