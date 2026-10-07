//! [`PluginKeepAlive`]: the runner's keep-alive port, through the
//! background-service plugin's `ServiceManagerHandle`.

use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{anyhow, Context};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_background_service::{ServiceError, ServiceManagerHandle, StartConfig};
use unit_runner::{KeepAliveOperation, KeepAlivePlatform};

use super::keep_alive_end_pairing::RUNNER_RELEASE_STOP_REASON;
use super::notification_permission::ask_for_notification_permission;

/// Starts and stops the plugin's one service, which is the keep-alive task
/// while it runs.
pub(crate) struct PluginKeepAlive<R: Runtime> {
    app: AppHandle<R>,
    start_config: StartConfig,
    notification_permission_asked: AtomicBool,
}

impl<R: Runtime> PluginKeepAlive<R> {
    pub(crate) fn new(app: AppHandle<R>, start_config: StartConfig) -> Self {
        Self {
            app,
            start_config,
            notification_permission_asked: AtomicBool::new(false),
        }
    }

    fn service_manager(&self) -> anyhow::Result<tauri::State<'_, ServiceManagerHandle<R>>> {
        self.app
            .try_state::<ServiceManagerHandle<R>>()
            .context("the background-service plugin is not registered")
    }
}

impl<R: Runtime> KeepAlivePlatform for PluginKeepAlive<R> {
    /// Start the service with the start config, after asking for notification
    /// permission the first time. A service already running counts as started.
    fn start(&self) -> KeepAliveOperation<'_> {
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
                Ok(()) | Err(ServiceError::AlreadyRunning) => Ok(()),
                Err(error) => Err(anyhow!("the background service didn't start: {error}")),
            }
        })
    }

    /// Stop the service with [`RUNNER_RELEASE_STOP_REASON`]. A service already
    /// stopped counts as stopped.
    fn stop(&self) -> KeepAliveOperation<'_> {
        Box::pin(async move {
            match self
                .service_manager()?
                .stop_with_reason(RUNNER_RELEASE_STOP_REASON)
                .await
            {
                Ok(()) | Err(ServiceError::NotRunning) => Ok(()),
                Err(error) => Err(anyhow!("the background service didn't stop: {error}")),
            }
        })
    }
}
