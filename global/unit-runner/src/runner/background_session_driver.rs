//! Starting and ending the background session to match `UnitRunner`'s demand,
//! through the [`BackgroundSessionPlatform`] port.

use std::sync::Arc;

use super::UnitRunner;
use crate::domain::session_ledger::SessionPhase;
use crate::ports::background_session_platform::BackgroundSessionPlatform;

/// Whether some unit should run, and where the background session is.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct SessionDemand {
    /// Some unit should run.
    pub(crate) some_unit_should_run: bool,
    /// Whether a background session is running, and whether `UnitRunner` is
    /// ending it.
    pub(crate) session_phase: SessionPhase,
}

/// Keep the platform's background session in step with `UnitRunner`: start one
/// whenever some unit should run and no session is running, and end it
/// whenever a session is running and no unit should run. While `UnitRunner` is
/// ending a session, wait for that session's end, which changes the demand,
/// before starting another: the platform would take a start then as one for
/// the session still running. One platform call at a time, for as long as
/// `UnitRunner` lives.
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
        match (demand.some_unit_should_run, demand.session_phase) {
            (true, SessionPhase::NoSession) => {
                if let Err(error) = platform.request_session_start().await {
                    log::error!(
                        "[unit-runner] failed to request the background session's start: {error:#}"
                    );
                }
            }
            (false, SessionPhase::Running) => {
                if unit_runner.mark_session_no_longer_needed().is_some() {
                    if let Err(error) = platform.request_session_end().await {
                        log::error!(
                            "[unit-runner] failed to request the background session's end: {error:#}"
                        );
                    }
                }
            }
            (true, SessionPhase::Running)
            | (false, SessionPhase::NoSession)
            | (_, SessionPhase::Ending) => {}
        }
        if session_demand_rx.changed().await.is_err() {
            return;
        }
    }
}
