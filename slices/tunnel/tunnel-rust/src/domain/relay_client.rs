//! The embedded rathole client that dials the relay.
//!
//! [`RelayClient`] is a one-attempt seam: `run_once` brings up a single rathole
//! client and returns when it exits. The [`http::TunnelState`](crate::http)
//! supervisor owns the retry/backoff loop and cancellation, so this layer holds
//! no run lifecycle of its own. The trait exists so the supervisor can be tested
//! against a fake instead of a live relay.
//!
//! rathole's public API only accepts a config *file* path, and its own `Config`
//! re-serializes the token as a masked `***`, so we render the client config
//! from our own typed structs with [`toml`] (escaping handled by construction)
//! to a temp file that lives for the duration of the attempt.
use tokio_util::sync::CancellationToken;

/// A fully-specified relay connection — produced only when every field the
/// rathole client needs is present. Also the shape a PUT sets the relay block
/// to (all four together, or none).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelaySettings {
    pub remote_addr: String,
    pub token: String,
    pub public_key: String,
    pub service_name: String,
}

/// Runs a single rathole client attempt. The supervisor calls this in a loop.
#[async_trait::async_trait]
pub trait RelayClient: Send + Sync {
    /// Forward `local_addr` to the relay per `relay`, running until the client
    /// exits. Resolves `Ok` on a clean stop — `cancel` fired, or the relay
    /// closed the session without error — and `Err` on a failure the supervisor
    /// should back off and retry (relay unreachable, handshake rejected).
    async fn run_once(
        &self,
        relay: &RelaySettings,
        local_addr: &str,
        cancel: CancellationToken,
    ) -> anyhow::Result<()>;
}
