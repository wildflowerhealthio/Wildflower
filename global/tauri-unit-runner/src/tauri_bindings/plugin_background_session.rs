//! [`PluginBackgroundSession`]: the runner's background session port, through
//! the background-service plugin's `ServiceManagerHandle`.

use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{anyhow, Context};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_background_service::{
    ServiceError as BackgroundServiceError, ServiceManagerHandle as BackgroundServiceManagerHandle,
    StartConfig as BackgroundServiceStartConfig,
};
use unit_runner::{BackgroundSessionOperation, BackgroundSessionPlatform};

use super::notification_permission::ask_for_notification_permission;
use super::session_end_pairing::NO_LONGER_NEEDED_STOP_REASON;

/// Starts and stops the plugin's one service, which is the background session
/// while it runs.
pub(crate) struct PluginBackgroundSession<R: Runtime> {
    app: AppHandle<R>,
    start_config: BackgroundServiceStartConfig,
    notification_permission_asked: AtomicBool,
}

impl<R: Runtime> PluginBackgroundSession<R> {
    pub(crate) fn new(app: AppHandle<R>, start_config: BackgroundServiceStartConfig) -> Self {
        Self {
            app,
            start_config,
            notification_permission_asked: AtomicBool::new(false),
        }
    }

    fn service_manager(
        &self,
    ) -> anyhow::Result<tauri::State<'_, BackgroundServiceManagerHandle<R>>> {
        self.app
            .try_state::<BackgroundServiceManagerHandle<R>>()
            .context("the background-service plugin is not registered")
    }
}

impl<R: Runtime> BackgroundSessionPlatform for PluginBackgroundSession<R> {
    /// Start the service with the start config, after asking for notification
    /// permission the first time. A service already running counts as started.
    fn start(&self) -> BackgroundSessionOperation<'_> {
        Box::pin(async move {
            if !self
                .notification_permission_asked
                .swap(true, Ordering::Relaxed)
            {
                ask_for_notification_permission(&self.app).await;
            }
            match self
                .service_manager()?
                .start(self.app.clone(), self.start_config.clone())
                .await
            {
                Ok(()) | Err(BackgroundServiceError::AlreadyRunning) => Ok(()),
                Err(error) => Err(anyhow!("the background service didn't start: {error}")),
            }
        })
    }

    /// Stop the service with [`NO_LONGER_NEEDED_STOP_REASON`]. A service
    /// already stopped counts as stopped.
    fn stop(&self) -> BackgroundSessionOperation<'_> {
        Box::pin(async move {
            match self
                .service_manager()?
                .stop_with_reason(NO_LONGER_NEEDED_STOP_REASON)
                .await
            {
                Ok(()) | Err(BackgroundServiceError::NotRunning) => Ok(()),
                Err(error) => Err(anyhow!("the background service didn't stop: {error}")),
            }
        })
    }
}
