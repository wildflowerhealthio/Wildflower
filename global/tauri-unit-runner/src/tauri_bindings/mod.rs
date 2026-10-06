//! The runner bound to Tauri: the lease as `tauri-plugin-background-service`'s
//! one [`BackgroundService`](tauri_plugin_background_service::BackgroundService),
//! and the app's use and resumes from its window events, as the two plugins
//! [`UnitRunner`] hands the app.

mod lease_end_pairing;
mod lease_holder;
mod lifecycle;
mod notification_permission;
mod plugin_lease;

use std::sync::Mutex;
use std::time::Duration;

use tauri::plugin::TauriPlugin;
use tauri::Runtime;
use tauri_plugin_background_service::{PluginConfig, StartConfig};

use crate::domain::use_signals::{UsePlatform, UseSignals};
use crate::unit_runner::UnitRunner;
use lease_end_pairing::LeaseEndPairing;
use lease_holder::LeaseHolder;

/// The name the runner's lifecycle plugin registers under.
pub const UNIT_RUNNER_PLUGIN_NAME: &str = "unit-runner";

/// How long, after the lease task ends, the runner waits for the plugin's
/// event that names the reason. The plugin emits it as soon as the task has
/// returned.
pub const LEASE_END_REASON_WAIT: Duration = Duration::from_secs(1);

/// The Tauri side's own state, shared by both plugins and every lease task.
pub(crate) struct TauriBindings {
    start_config: StartConfig,
    lease_end_pairing: LeaseEndPairing,
    use_signals: Mutex<UseSignals>,
}

impl TauriBindings {
    pub(crate) fn new(start_config: StartConfig) -> Self {
        Self {
            start_config,
            lease_end_pairing: LeaseEndPairing::default(),
            use_signals: Mutex::new(UseSignals::new(UsePlatform::current())),
        }
    }
}

impl<D: Clone + Send + Sync + 'static> UnitRunner<D> {
    /// `tauri-plugin-background-service`, with the runner's lease as its one
    /// service. Register it once, before the app's `setup()`.
    ///
    /// Each start of the service, whether the runner, the plugin's recovery or
    /// an iOS background task made it, hands the runner the lease until the
    /// service stops. Units never run inside the service's task; it only keeps
    /// the app alive.
    #[must_use]
    pub fn background_service_plugin<R: Runtime>(&self) -> TauriPlugin<R, PluginConfig> {
        let runner = self.clone();
        tauri_plugin_background_service::init_with_service(move || LeaseHolder::new(runner.clone()))
    }

    /// The runner's own plugin, [`UNIT_RUNNER_PLUGIN_NAME`]. Register it once,
    /// alongside [`background_service_plugin`](Self::background_service_plugin)
    /// and `tauri-plugin-notification`.
    ///
    /// It follows the app's windows to tell when the app is in use, restarts
    /// every running unit on an iOS resume, learns why the platform ended the
    /// lease from the background-service plugin's events, and takes and
    /// releases the lease from the moment the app's event loop is ready, after
    /// the app's `setup()` has set its units.
    #[must_use]
    pub fn lifecycle_plugin<R: Runtime>(&self) -> TauriPlugin<R> {
        lifecycle::plugin(self.clone())
    }
}
