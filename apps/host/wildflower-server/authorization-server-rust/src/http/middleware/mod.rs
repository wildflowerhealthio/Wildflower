mod authorization_start_limit;
mod cache_suppression;
mod require_valid_bearer_token;
pub(crate) use authorization_start_limit::{limit_authorization_starts, AuthorizationStartRoute};
pub use cache_suppression::cache_suppress;
pub mod require_auth;
pub use require_auth::require_valid_session;
pub use require_valid_bearer_token::{
    authorization_server_auth_middleware, ensure_bearer_header, AuthorizationServerAuthMiddleware,
};

/// Boxed so the `from_fn` handlers' layer types are nameable.
type MiddlewareFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = axum::response::Response> + Send>>;
