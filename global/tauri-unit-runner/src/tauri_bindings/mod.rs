//! The runner bound to Tauri: the keep-alive as
//! `tauri-plugin-background-service`'s one
//! [`BackgroundService`](tauri_plugin_background_service::BackgroundService),
//! and whether the app is open and resumes from its window events, as the two
//! plugins [`UnitRunner`] hands the app.

mod keep_alive_end_pairing;
mod keep_alive_service;
mod lifecycle;
mod notification_permission;
mod plugin_keep_alive;

use std::sync::Mutex;
use std::time::Duration;

use tauri::plugin::TauriPlugin;
use tauri::Runtime;
use tauri_plugin_background_service::{
    PluginConfig as BackgroundServicePluginConfig, StartConfig as BackgroundServiceStartConfig,
};

use crate::domain::window_state::{PlatformKind, WindowState};
use crate::runner::UnitRunner;
use keep_alive_end_pairing::KeepAliveEndPairing;
use keep_alive_service::KeepAliveService;

/// The name the runner's lifecycle plugin registers under.
pub const UNIT_RUNNER_PLUGIN_NAME: &str = "unit-runner";

/// How long, after the keep-alive task ends, the runner waits for the plugin's
/// event that names the reason. The plugin emits it as soon as the task has
/// returned.
pub const KEEP_ALIVE_END_REASON_WAIT: Duration = Duration::from_secs(1);

/// The Tauri side's own state, shared by both plugins and every keep-alive
/// task.
pub(crate) struct TauriBindings {
    start_config: BackgroundServiceStartConfig,
    keep_alive_end_pairing: KeepAliveEndPairing,
    window_state: Mutex<WindowState>,
}

impl TauriBindings {
    pub(crate) fn new(start_config: BackgroundServiceStartConfig) -> Self {
        Self {
            start_config,
            keep_alive_end_pairing: KeepAliveEndPairing::default(),
            window_state: Mutex::new(WindowState::new(PlatformKind::current())),
        }
    }
}

impl<D: Clone + Send + Sync + 'static> UnitRunner<D> {
    /// `tauri-plugin-background-service`, with the runner's keep-alive as its
    /// one service. Register it once, before the app's `setup()`.
    ///
    /// Each start of the service, whether the runner, the plugin's recovery or
    /// an iOS background task made it, is a keep-alive task the runner counts
    /// on until the service stops. Units never run inside the service's task;
    /// it only keeps the app alive.
    #[must_use]
    pub fn background_service_plugin<R: Runtime>(
        &self,
    ) -> TauriPlugin<R, BackgroundServicePluginConfig> {
        let runner = self.clone();
        tauri_plugin_background_service::init_with_service(move || {
            KeepAliveService::new(runner.clone())
        })
    }

    /// The runner's own plugin, [`UNIT_RUNNER_PLUGIN_NAME`]. Register it once,
    /// alongside [`background_service_plugin`](Self::background_service_plugin)
    /// and `tauri-plugin-notification`.
    ///
    /// It follows the app's windows to tell when the app is open, restarts
    /// every running unit on an iOS resume, learns why the platform ended the
    /// keep-alive from the background-service plugin's events, and starts and
    /// stops the keep-alive from the moment the app's event loop is ready,
    /// after the app's `setup()` has set its units.
    #[must_use]
    pub fn lifecycle_plugin<R: Runtime>(&self) -> TauriPlugin<R> {
        lifecycle::plugin(self.clone())
    }
}
