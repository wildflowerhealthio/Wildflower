//! The server's own HTTP layer: the [`middleware`] it wraps the composed slice
//! routers in, the [`health`] checks its `/health` serves, and the
//! [`not_found`] fallback for routes no slice claims.

pub(crate) mod health;
pub(crate) mod middleware;
pub(crate) mod not_found;
