//! The launch → tunnel seam: a port the apps slice depends on so a
//! `requires_tunnel` launch can resolve to the live, *verified* public origin
//! without apps-rust depending on tunnel-rust directly.
//!
//! The host implements [`TunnelLaunchResolver`] by delegating to the tunnel
//! slice's control seam (`tunnel_rust::TunnelControl::request_start`, which
//! turns the tunnel on and only returns once a `/health` probe has verified it).
//! Tests and tunnel-less hosts use [`TunnelUnavailable`].

/// Resolves the origin a `requires_tunnel` launch should target.
///
/// `Some(origin)` is the verified public origin the launch redirects to;
/// `None` means the tunnel couldn't be brought up, and the caller falls back to
/// the loopback origin with `?tunnel=unavailable` so the SPA can surface a
/// banner.
#[async_trait::async_trait]
pub trait TunnelLaunchResolver: Send + Sync {
    /// Bring the tunnel up (if needed) and return its verified public origin, or
    /// `None` if it isn't reachable.
    async fn resolve_tunnel_origin(&self) -> Option<String>;
}

/// The default resolver: there is no tunnel, so every `requires_tunnel` launch
/// falls back to loopback + `?tunnel=unavailable`. Used by tests and by hosts
/// that don't wire the tunnel control seam.
pub struct TunnelUnavailable;

#[async_trait::async_trait]
impl TunnelLaunchResolver for TunnelUnavailable {
    async fn resolve_tunnel_origin(&self) -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unavailable_resolver_never_resolves_an_origin() {
        assert_eq!(TunnelUnavailable.resolve_tunnel_origin().await, None);
    }
}
