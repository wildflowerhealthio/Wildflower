//! The authorization server's middleware: the two bearer gates that turn a
//! request's access token into claims (the session gate on `/authorization`,
//! and the layerable bearer gate the host wraps its downstream routers in), the
//! authorization start limit, and the cache suppression every `/authorization`
//! response passes through.

mod authorization_start_limit;
mod cache_suppression;
mod require_valid_bearer_token;
pub(crate) use authorization_start_limit::{
    defer_authorization_start_limit, limit_authorization_starts, start_limited_response,
    AuthorizationStartRoute, DeferredStartLimit, StartLimitAskedNow,
};
pub use cache_suppression::cache_suppress;
pub mod require_auth;
pub use require_auth::require_valid_session;
pub use require_valid_bearer_token::{
    authorization_server_auth_middleware, ensure_bearer_header, AuthorizationServerAuthMiddleware,
};

/// Boxed so the `from_fn` handlers' layer types are nameable.
type MiddlewareFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = axum::response::Response> + Send>>;
