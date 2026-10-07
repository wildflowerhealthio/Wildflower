//! [`TauriUnitRunner`], what the app builds before its Tauri builder and pushes
//! its units to.

use std::sync::Arc;

use tauri_plugin_background_service::StartConfig as BackgroundServiceStartConfig;
use tokio::sync::watch;

use unit_runner::{RunPolicy, SystemClock, Unit, UnitId, UnitRunner, UnitStatuses};

use crate::tauri_bindings::TauriBindings;

/// Holds the app's units, reconciles their runs with their policies, and keeps
/// the app alive while any of them should run: a [`UnitRunner`] bound to
/// Tauri.
///
/// Build it before the Tauri builder, and register both of its plugins:
///
/// ```rust,ignore
/// let runner = TauriUnitRunner::<MyDetail>::new(BackgroundServiceStartConfig {
///     service_label: "Syncing in the background".to_owned(),
///     foreground_service_type: "dataSync".to_owned(),
/// });
/// tauri::Builder::default()
///     .plugin(tauri_plugin_notification::init())
///     .plugin(runner.background_service_plugin())
///     .plugin(runner.lifecycle_plugin())
///     .setup(move |app| {
///         for (id, policy) in read_my_registry(app)? {
///             runner.set_unit(id, policy, move || Ok(MyUnit::new(/* … */)));
///         }
///         Ok(())
///     })
/// ```
///
/// The app pushes; `TauriUnitRunner` never reads the app's storage and never
/// changes a policy. Cloning is cheap; every clone is the same
/// `TauriUnitRunner`.
pub struct TauriUnitRunner<D> {
    pub(crate) unit_runner: Arc<UnitRunner<D>>,
    pub(crate) bindings: Arc<TauriBindings>,
}

impl<D> Clone for TauriUnitRunner<D> {
    fn clone(&self) -> Self {
        Self {
            unit_runner: Arc::clone(&self.unit_runner),
            bindings: Arc::clone(&self.bindings),
        }
    }
}

impl<D: Clone + Send + Sync + 'static> TauriUnitRunner<D> {
    /// A `TauriUnitRunner` with no units, whose background session starts the
    /// service with `start_config`: on Android, its label is the text of the
    /// persistent foreground-service notification that covers every unit, and
    /// its type must be one the plugin config's `androidForegroundServiceTypes`
    /// allows.
    ///
    /// Runs and timers run on Tauri's async runtime, so this works before the
    /// Tauri builder exists.
    #[must_use]
    pub fn new(start_config: BackgroundServiceStartConfig) -> Self {
        let runtime = tauri::async_runtime::handle().inner().clone();
        let unit_runner = UnitRunner::new(runtime, Arc::new(SystemClock));
        Self::from_unit_runner(unit_runner, start_config)
    }

    pub(crate) fn from_unit_runner(
        unit_runner: Arc<UnitRunner<D>>,
        start_config: BackgroundServiceStartConfig,
    ) -> Self {
        Self {
            unit_runner,
            bindings: Arc::new(TauriBindings::new(start_config)),
        }
    }

    /// Add the unit `unit_id` with `policy`, whose runs are built by `factory`;
    /// or, for a unit already set, replace its policy and factory, stopping a
    /// run of the old definition. The unit starts at once if it should run.
    ///
    /// A factory that fails is a failed run.
    pub fn set_unit<U: Unit<Detail = D>>(
        &self,
        unit_id: UnitId,
        policy: RunPolicy,
        factory: impl Fn() -> anyhow::Result<U> + Send + Sync + 'static,
    ) {
        self.unit_runner.set_unit(unit_id, policy, factory);
    }

    /// Replace the policy of the unit `unit_id`. Even with the policy it
    /// already has, this cancels a pending restart and starts the unit at once
    /// if it should run, after the platform ended the background session too. A
    /// unit never set is logged and ignored.
    pub fn set_unit_policy(&self, unit_id: &UnitId, policy: RunPolicy) {
        self.unit_runner.set_unit_policy(unit_id, policy);
    }

    /// Stop the unit `unit_id`, wait for its run to end, and forget it, status
    /// included. Run shutdown is bounded, so this always finishes. A unit never
    /// set is logged and ignored.
    pub async fn remove_unit(&self, unit_id: &UnitId) {
        self.unit_runner.remove_unit(unit_id).await;
    }

    /// Every unit's current status.
    #[must_use]
    pub fn statuses(&self) -> UnitStatuses<D> {
        self.unit_runner.statuses()
    }

    /// Every unit's status, as it changes. The receiver always holds the
    /// current statuses; a slow reader sees the latest, not every step.
    #[must_use]
    pub fn subscribe(&self) -> watch::Receiver<UnitStatuses<D>> {
        self.unit_runner.subscribe()
    }
}
