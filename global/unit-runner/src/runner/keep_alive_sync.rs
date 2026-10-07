//! Starting and stopping the keep-alive task to match the runner's demand,
//! through the [`KeepAlivePlatform`] port.

use std::sync::Arc;

use super::UnitRunnerCore;
use crate::ports::keep_alive_platform::KeepAlivePlatform;

/// Whether the runner wants the keep-alive, and whether a task is running
/// that the runner is keeping.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct KeepAliveDemand {
    /// Some unit should run.
    pub(crate) wanted: bool,
    /// A keep-alive task is running and the runner hasn't asked it to stop.
    pub(crate) kept: bool,
}

/// Keep the platform's keep-alive task in step with the runner: start it
/// whenever some unit should run and no task is kept, and stop it whenever a
/// task is kept and no unit should run. One platform call at a time, for as
/// long as the runner lives.
///
/// The task is what keeps the app alive in the background while units run.
/// Starting and stopping it are async and the platform can start or end it
/// on its own, so this only asks; the task reports back to the runner.
///
/// A call that fails is logged and not retried until the demand next changes.
/// The units run either way, as the keep-alive only keeps the app alive in the
/// background.
pub(crate) async fn sync_keep_alive<D: Clone + Send + Sync + 'static>(
    core: Arc<UnitRunnerCore<D>>,
    platform: Arc<dyn KeepAlivePlatform>,
) {
    let mut keep_alive_demand_rx = core.subscribe_keep_alive_demand();
    loop {
        let demand = *keep_alive_demand_rx.borrow_and_update();
        if demand.wanted && !demand.kept {
            if let Err(error) = platform.start().await {
                log::error!("[unit-runner] failed to start the keep-alive: {error:#}");
            }
        } else if !demand.wanted && demand.kept && core.request_keep_alive_release().is_some() {
            if let Err(error) = platform.stop().await {
                log::error!("[unit-runner] failed to stop the keep-alive: {error:#}");
            }
        }
        if keep_alive_demand_rx.changed().await.is_err() {
            return;
        }
    }
}
