//! Test doubles shared across the tunnel slice's unit tests. Kept in one place
//! so a change to the `RelayClient`/`HealthProbe` trait signatures touches a
//! single definition instead of the copy in every test module.

use tokio_util::sync::CancellationToken;

use crate::domain::{RelayClient, RelaySettings};
use crate::health::HealthProbe;

/// A relay client that holds the session until cancelled — a stable "up" dial
/// the probe runs against.
pub(crate) struct HoldUntilCancelRelayClient;

#[async_trait::async_trait]
impl RelayClient for HoldUntilCancelRelayClient {
    async fn run_once(
        &self,
        _relay: &RelaySettings,
        _local_addr: &str,
        cancel: CancellationToken,
    ) -> anyhow::Result<()> {
        cancel.cancelled().await;
        Ok(())
    }
}

/// A `/health` probe with a fixed, cloneable outcome.
pub(crate) struct StubProbe(pub(crate) Result<(), String>);

impl StubProbe {
    pub(crate) fn passing() -> Self {
        Self(Ok(()))
    }
    pub(crate) fn failing() -> Self {
        Self(Err("connection refused".to_string()))
    }
}

#[async_trait::async_trait]
impl HealthProbe for StubProbe {
    async fn probe(&self, _url: &str) -> Result<(), String> {
        self.0.clone()
    }
}
