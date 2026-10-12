//! The server's own HTTP layer: the [`middleware`] it wraps the composed slice
//! routers in, the [`health`] checks its `/health` serves, the
//! [`root_fallback`] that sends a request no slice route claims to the FHIR API
//! or the [`not_found`] page, and the [`tunnel_listener`] the tunnel's
//! connections are served on.

pub(crate) mod health;
pub(crate) mod middleware;
pub(crate) mod not_found;
pub(crate) mod root_fallback;
pub(crate) mod tunnel_listener;
