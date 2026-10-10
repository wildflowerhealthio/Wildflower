//! [`UnitRunner`](unit_runner_rust::UnitRunner) bound to Tauri: the background
//! session as `tauri-plugin-background-service`'s one
//! [`BackgroundService`](tauri_plugin_background_service::BackgroundService),
//! and whether the app is present and returns to the foreground from its
//! window events, as the two plugins [`TauriUnitRunner`] hands the app.

mod background_session_service;
mod lifecycle;
mod notification_permission;
mod plugin_background_session;
mod session_end_pairing;

use std::sync::Mutex;
use std::time::Duration;

use tauri::plugin::TauriPlugin;
use tauri::Runtime;
use tauri_plugin_background_service::{
    PluginConfig as BackgroundServicePluginConfig, StartConfig as BackgroundServiceStartConfig,
};

use crate::domain::window_state::{PlatformKind, WindowState};
use crate::tauri_unit_runner::TauriUnitRunner;
use background_session_service::BackgroundSessionService;
use session_end_pairing::SessionEndPairing;

/// The name `TauriUnitRunner`'s lifecycle plugin registers under.
pub const UNIT_RUNNER_PLUGIN_NAME: &str = "unit-runner";

/// How long, after a background session ends, `TauriUnitRunner` waits for the
/// plugin's event that names the reason. The plugin emits it as soon as the
/// session's task has returned.
pub const SESSION_END_REASON_WAIT: Duration = Duration::from_secs(1);

/// The Tauri side's own state, shared by both plugins and every background
/// session.
pub(crate) struct TauriBindings {
    start_config: BackgroundServiceStartConfig,
    session_end_pairing: SessionEndPairing,
    window_state: Mutex<WindowState>,
}

impl TauriBindings {
    pub(crate) fn new(start_config: BackgroundServiceStartConfig) -> Self {
        Self {
            start_config,
            session_end_pairing: SessionEndPairing::default(),
            window_state: Mutex::new(WindowState::new(PlatformKind::current())),
        }
    }
}

impl<D: Clone + Send + Sync + 'static> TauriUnitRunner<D> {
    /// `tauri-plugin-background-service`, with `TauriUnitRunner`'s background
    /// session as its one service. Register it once, before the app's
    /// `setup()`.
    ///
    /// Each start of the service, whether `TauriUnitRunner`, the plugin's
    /// recovery or an iOS background task made it, is a background session
    /// `TauriUnitRunner` counts on until the service stops. Units never run
    /// inside the service's task; it only keeps the app alive.
    #[must_use]
    pub fn background_service_plugin<R: Runtime>(
        &self,
    ) -> TauriPlugin<R, BackgroundServicePluginConfig> {
        let runner = self.clone();
        tauri_plugin_background_service::init_with_service(move || {
            BackgroundSessionService::new(runner.clone())
        })
    }

    /// `TauriUnitRunner`'s own plugin, [`UNIT_RUNNER_PLUGIN_NAME`]. Register it
    /// once, alongside
    /// [`background_service_plugin`](Self::background_service_plugin) and
    /// `tauri-plugin-notification`.
    ///
    /// It follows the app's windows to tell when the app is present, restarts
    /// every running unit when an iOS app returns to the foreground, learns why
    /// the platform ended a background session from the background-service
    /// plugin's events, and starts and ends the session from the moment the
    /// app's event loop is ready, after the app's `setup()` has set its units.
    #[must_use]
    pub fn lifecycle_plugin<R: Runtime>(&self) -> TauriPlugin<R> {
        lifecycle::plugin(self.clone())
    }
}
