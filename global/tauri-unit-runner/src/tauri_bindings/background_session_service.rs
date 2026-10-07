//! [`BackgroundSessionService`], the background-service plugin's one service:
//! while the plugin runs it, it is the runner's background session.

use tauri::Runtime;
use tauri_plugin_background_service::{
    BackgroundService, ServiceContext as BackgroundServiceContext,
    ServiceError as BackgroundServiceError,
};

use super::SESSION_END_REASON_WAIT;
use crate::runner::UnitRunner;

/// The service the plugin builds for each of its starts. Its task tells the
/// runner the background session started, runs until the plugin's shutdown,
/// and then reports the session's end with the plugin's reason for it.
pub(crate) struct BackgroundSessionService<D> {
    runner: UnitRunner<D>,
}

impl<D> BackgroundSessionService<D> {
    pub(crate) fn new(runner: UnitRunner<D>) -> Self {
        Self { runner }
    }
}

#[async_trait::async_trait]
impl<R: Runtime, D: Clone + Send + Sync + 'static> BackgroundService<R>
    for BackgroundSessionService<D>
{
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
        let session = self.runner.core.session_started();
        let shutdown_requested = &ctx.shutdown;
        shutdown_requested.cancelled().await;
        // The plugin emits the end's reason once this returns.
        let end_reason_rx = self.runner.bindings.session_end_pairing.wait_for_end();
        let core = std::sync::Arc::clone(&self.runner.core);
        self.runner.core.runtime().spawn(async move {
            let platform_reason =
                match tokio::time::timeout(SESSION_END_REASON_WAIT, end_reason_rx).await {
                    Ok(Ok(end)) => end.platform_reason(),
                    Ok(Err(_)) | Err(_) => {
                        log::warn!(
                            "[unit-runner] no reason came for the end of background session \
                             {session:?}"
                        );
                        None
                    }
                };
            core.session_ended(session, platform_reason);
        });
        Ok(())
    }
}
