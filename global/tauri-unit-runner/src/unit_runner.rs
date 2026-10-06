//! [`UnitRunner`], what the app builds before its Tauri builder and pushes its
//! units to.

use std::sync::Arc;

use tauri_plugin_background_service::StartConfig;
use tokio::sync::watch;

use crate::domain::run_policy::RunPolicy;
use crate::runner::wall_clock::SystemClock;
use crate::runner::{erase_factory, RunnerCore, RunnerTimings};
use crate::status::UnitStatuses;
use crate::tauri_bindings::TauriBindings;
use crate::unit::{Unit, UnitId};

/// Holds the app's units, reconciles their runs with their policies, and holds
/// the lease.
///
/// Build it before the Tauri builder, and register both of its plugins:
///
/// ```rust,ignore
/// let runner = UnitRunner::<MyDetail>::new(StartConfig {
///     service_label: "Syncing in the background".to_owned(),
///     foreground_service_type: "dataSync".to_owned(),
/// });
/// tauri::Builder::default()
///     .plugin(tauri_plugin_notification::init())
///     .plugin(runner.background_service_plugin())
///     .plugin(runner.lifecycle_plugin())
///     .setup(move |app| {
///         for (id, policy) in read_my_registry(app)? {
///             runner.set(id, policy, move || Ok(MyUnit::new(/* … */)));
///         }
///         Ok(())
///     })
/// ```
///
/// The app pushes; the runner never reads the app's storage and never changes
/// a policy. Cloning is cheap; every clone is the same runner.
pub struct UnitRunner<D> {
    pub(crate) core: Arc<RunnerCore<D>>,
    pub(crate) bindings: Arc<TauriBindings>,
}

impl<D> Clone for UnitRunner<D> {
    fn clone(&self) -> Self {
        Self {
            core: Arc::clone(&self.core),
            bindings: Arc::clone(&self.bindings),
        }
    }
}

impl<D: Clone + Send + Sync + 'static> UnitRunner<D> {
    /// A runner with no units, whose lease starts the background service with
    /// `start_config`: on Android, its label is the text of the persistent
    /// foreground-service notification that covers every unit, and its type
    /// must be one the plugin config's `androidForegroundServiceTypes` allows.
    ///
    /// Runs and timers run on Tauri's async runtime, so this works before the
    /// Tauri builder exists.
    #[must_use]
    pub fn new(start_config: StartConfig) -> Self {
        let runtime = tauri::async_runtime::handle().inner().clone();
        let core = RunnerCore::new(runtime, Arc::new(SystemClock), RunnerTimings::default());
        Self::from_core(core, start_config)
    }

    pub(crate) fn from_core(core: Arc<RunnerCore<D>>, start_config: StartConfig) -> Self {
        Self {
            core,
            bindings: Arc::new(TauriBindings::new(start_config)),
        }
    }

    /// Add the unit `unit_id` with `policy`, whose runs are built by `factory`;
    /// or, for a unit already set, replace its policy and factory, stopping a
    /// run of the old definition. The unit starts at once if it should run.
    ///
    /// A factory that fails is a failed run.
    pub fn set<U: Unit<Detail = D>>(
        &self,
        unit_id: UnitId,
        policy: RunPolicy,
        factory: impl Fn() -> anyhow::Result<U> + Send + Sync + 'static,
    ) {
        self.core.set(unit_id, policy, erase_factory(factory));
    }

    /// Replace the policy of the unit `unit_id`. Even with the policy it already
    /// has, this cancels a pending restart and starts the unit at once if it
    /// should run, after the platform ended the lease too. A unit never set is
    /// logged and ignored.
    pub fn set_policy(&self, unit_id: &UnitId, policy: RunPolicy) {
        self.core.set_policy(unit_id, policy);
    }

    /// Stop the unit `unit_id`, wait for its run to end, and forget it, status
    /// included. Run shutdown is bounded, so this always finishes. A unit never
    /// set is logged and ignored.
    pub async fn remove(&self, unit_id: &UnitId) {
        self.core.remove(unit_id).await;
    }

    /// Every unit's current status.
    #[must_use]
    pub fn statuses(&self) -> UnitStatuses<D> {
        self.core.statuses()
    }

    /// Every unit's status, as it changes. The receiver always holds the
    /// current statuses; a slow reader sees the latest, not every step.
    #[must_use]
    pub fn subscribe(&self) -> watch::Receiver<UnitStatuses<D>> {
        self.core.subscribe()
    }
}
