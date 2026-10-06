//! Taking and releasing the lease to match the runner's demand, through the
//! [`LeasePlatform`] seam.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use super::RunnerCore;

/// A lease operation's future.
pub(crate) type LeaseOperation<'a> = Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send + 'a>>;

/// What the runner needs from the platform to hold the lease: the
/// background-service plugin in an app, a fake in tests.
///
/// Neither call hands over or takes back the lease itself. The lease task the
/// platform then starts reports its start and end to the runner
/// ([`RunnerCore::lease_gained`], [`RunnerCore::lease_ended`]), whoever started
/// it.
pub(crate) trait LeasePlatform: Send + Sync + 'static {
    /// Start the lease task. A task already running counts as started.
    fn take(&self) -> LeaseOperation<'_>;

    /// Stop the lease task, with the runner's own stop reason. A task already
    /// stopped counts as stopped.
    fn release(&self) -> LeaseOperation<'_>;
}

/// Whether the runner wants the lease, and whether it holds one it is keeping.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct LeaseDemand {
    /// Some unit should run.
    pub(crate) wanted: bool,
    /// The runner holds a lease it isn't releasing.
    pub(crate) held: bool,
}

/// Take the lease whenever the runner wants it and holds none, and release it
/// whenever it holds one and wants none, one platform call at a time, for as
/// long as the runner lives.
///
/// A call that fails is logged and not retried until the demand next changes;
/// the units run either way, as the lease only keeps the app alive in the
/// background.
pub(crate) async fn drive_lease<D: Clone + Send + Sync + 'static>(
    core: Arc<RunnerCore<D>>,
    platform: Arc<dyn LeasePlatform>,
) {
    let mut lease_demand_rx = core.subscribe_lease_demand();
    loop {
        let demand = *lease_demand_rx.borrow_and_update();
        if demand.wanted && !demand.held {
            if let Err(error) = platform.take().await {
                log::error!("[unit-runner] failed to take the lease: {error:#}");
            }
        } else if !demand.wanted && demand.held && core.begin_lease_release().is_some() {
            if let Err(error) = platform.release().await {
                log::error!("[unit-runner] failed to release the lease: {error:#}");
            }
        }
        if lease_demand_rx.changed().await.is_err() {
            return;
        }
    }
}
