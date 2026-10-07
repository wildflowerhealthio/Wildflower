//! [`KeepAliveService`], the background-service plugin's one service: while
//! the plugin runs it, it is the runner's keep-alive task.

use tauri::Runtime;
use tauri_plugin_background_service::{
    BackgroundService, ServiceContext as BackgroundServiceContext,
    ServiceError as BackgroundServiceError,
};

use super::KEEP_ALIVE_END_REASON_WAIT;
use crate::runner::UnitRunner;

/// The service the plugin builds for each of its starts. Its task tells the
/// runner the keep-alive started, runs until the plugin's shutdown, and then
/// reports the keep-alive's end with the plugin's reason for it.
pub(crate) struct KeepAliveService<D> {
    runner: UnitRunner<D>,
}

impl<D> KeepAliveService<D> {
    pub(crate) fn new(runner: UnitRunner<D>) -> Self {
        Self { runner }
    }
}

#[async_trait::async_trait]
impl<R: Runtime, D: Clone + Send + Sync + 'static> BackgroundService<R> for KeepAliveService<D> {
    async fn init(
        &mut self,
        _ctx: &BackgroundServiceContext<R>,
    ) -> Result<(), BackgroundServiceError> {
        Ok(())
    }

    /// Keep the app alive until the plugin shuts the service down. Never
    /// fails, so the plugin's event for its end is always a stop with the
    /// stopper's reason.
    async fn run(
        &mut self,
        ctx: &BackgroundServiceContext<R>,
    ) -> Result<(), BackgroundServiceError> {
        let keep_alive = self.runner.core.keep_alive_started();
        ctx.shutdown.cancelled().await;
        // The plugin emits the end's reason once this returns.
        let end_rx = self.runner.bindings.keep_alive_end_pairing.wait_for_end();
        let core = std::sync::Arc::clone(&self.runner.core);
        self.runner.core.runtime().spawn(async move {
            let platform_reason =
                match tokio::time::timeout(KEEP_ALIVE_END_REASON_WAIT, end_rx).await {
                    Ok(Ok(end)) => end.platform_reason(),
                    Ok(Err(_)) | Err(_) => {
                        log::warn!(
                            "[unit-runner] no reason came for the end of keep-alive {keep_alive:?}"
                        );
                        None
                    }
                };
            core.keep_alive_ended(keep_alive, platform_reason);
        });
        Ok(())
    }
}
