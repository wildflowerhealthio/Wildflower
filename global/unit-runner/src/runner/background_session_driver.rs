//! Starting and ending the background session to match `UnitRunner`'s demand,
//! through the [`BackgroundSessionPlatform`] port.

use std::sync::Arc;

use super::UnitRunner;
use crate::ports::background_session_platform::BackgroundSessionPlatform;

/// Whether some unit should run, and whether a session is running that
/// `UnitRunner` isn't ending.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct SessionDemand {
    /// Some unit should run.
    pub(crate) some_unit_should_run: bool,
    /// A background session is running and `UnitRunner` isn't ending it.
    pub(crate) session_running_and_not_ending: bool,
}

/// Keep the platform's background session in step with `UnitRunner`: start one
/// whenever some unit should run and no session is running unended, and end
/// it whenever a session is running unended and no unit should run. One
/// platform call at a time, for as long as `UnitRunner` lives.
///
/// The session is what keeps the app alive in the background while units run.
/// Starting and ending it are async and the platform can start or end it on
/// its own, so this only asks; the session reports back to `UnitRunner`.
///
/// A call that fails is logged and not retried until the demand next changes.
/// The units run either way, as the session only keeps the app alive in the
/// background.
pub(crate) async fn drive_background_session<D: Clone + Send + Sync + 'static>(
    unit_runner: Arc<UnitRunner<D>>,
    platform: Arc<dyn BackgroundSessionPlatform>,
) {
    let mut session_demand_rx = unit_runner.subscribe_session_demand();
    loop {
        let demand = *session_demand_rx.borrow_and_update();
        let session_should_start =
            demand.some_unit_should_run && !demand.session_running_and_not_ending;
        let session_should_end =
            !demand.some_unit_should_run && demand.session_running_and_not_ending;
        if session_should_start {
            if let Err(error) = platform.start().await {
                log::error!("[unit-runner] failed to start the background session: {error:#}");
            }
        } else if session_should_end && unit_runner.mark_session_no_longer_needed().is_some() {
            if let Err(error) = platform.stop().await {
                log::error!("[unit-runner] failed to end the background session: {error:#}");
            }
        }
        if session_demand_rx.changed().await.is_err() {
            return;
        }
    }
}
