mod require_loopback_peer;
mod require_valid_bearer_token;
pub use require_loopback_peer::{require_loopback_peer_middleware, RequireLoopbackPeerMiddleware};
pub mod require_auth;
pub use require_auth::require_valid_session;
pub use require_valid_bearer_token::{
    ensure_bearer_header, gatekeeper_auth_middleware, GatekeeperAuthMiddleware,
};

/// Boxed so the `from_fn` handlers' layer types are nameable.
type MiddlewareFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = axum::response::Response> + Send>>;
