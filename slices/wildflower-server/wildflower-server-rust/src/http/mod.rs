//! The server's own HTTP layer: the [`middleware`] it wraps the composed slice
//! routers in, the [`health`] checks its `/health` serves, the [`not_found`]
//! fallback for routes no slice claims, and the [`tunnel_listener`] the
//! tunnel's connections are served on.

pub(crate) mod health;
pub(crate) mod middleware;
pub(crate) mod not_found;
pub(crate) mod tunnel_listener;
