//! [`LeaseHolder`], the background-service plugin's one service: it holds the
//! lease for the runner while the plugin runs it.

use tauri::Runtime;
use tauri_plugin_background_service::{BackgroundService, ServiceContext, ServiceError};

use super::LEASE_END_REASON_WAIT;
use crate::unit_runner::UnitRunner;

/// The service the plugin builds for each of its starts. Its task hands the
/// runner the lease, holds it until the plugin's shutdown, and then reports
/// the lease's end with the plugin's reason for it.
pub(crate) struct LeaseHolder<D> {
    runner: UnitRunner<D>,
}

impl<D> LeaseHolder<D> {
    pub(crate) fn new(runner: UnitRunner<D>) -> Self {
        Self { runner }
    }
}

#[async_trait::async_trait]
impl<R: Runtime, D: Clone + Send + Sync + 'static> BackgroundService<R> for LeaseHolder<D> {
    async fn init(&mut self, _ctx: &ServiceContext<R>) -> Result<(), ServiceError> {
        Ok(())
    }

    /// Hold the lease until the plugin shuts the service down. Never fails, so
    /// the plugin's event for its end is always a stop with the stopper's
    /// reason.
    async fn run(&mut self, ctx: &ServiceContext<R>) -> Result<(), ServiceError> {
        let lease = self.runner.core.lease_gained();
        ctx.shutdown.cancelled().await;
        // The plugin emits the end's reason once this returns.
        let end_rx = self.runner.bindings.lease_end_pairing.wait_for_end();
        let core = std::sync::Arc::clone(&self.runner.core);
        self.runner.core.runtime().spawn(async move {
            let platform_reason = match tokio::time::timeout(LEASE_END_REASON_WAIT, end_rx).await {
                Ok(Ok(end)) => end.platform_reason(),
                Ok(Err(_)) | Err(_) => {
                    log::warn!("[unit-runner] no reason came for the end of lease {lease:?}");
                    None
                }
            };
            core.lease_ended(lease, platform_reason);
        });
        Ok(())
    }
}
