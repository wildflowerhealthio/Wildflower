//! The server's own HTTP layer: the [`middleware`] it wraps the composed slice
//! routers in, the [`not_found`] fallback for routes no slice claims, and the
//! [`listener_identity`] each request carries.

pub(crate) mod listener_identity;
pub(crate) mod middleware;
pub(crate) mod not_found;
