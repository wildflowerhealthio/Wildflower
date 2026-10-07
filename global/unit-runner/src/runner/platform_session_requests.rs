//! Asking the platform for the background session's starts and ends that
//! `UnitRunner`'s session demand calls for.
//!
//! `UnitRunner` decides under its state lock and never awaits there, so it
//! only publishes its [`SessionDemand`](crate::domain::session_plan::SessionDemand).
//! This task is the one place that waits on the [`BackgroundSessionPlatform`].
//! [`attach_background_session_platform`](UnitRunner::attach_background_session_platform)
//! starts it, and it runs until `UnitRunner`'s runtime shuts down.
//!
//! It follows the latest demand: the demand is a watch, so a demand replaced
//! while a request is in flight is skipped, and only the one that holds once
//! the request returns is planned. A request that fails is logged and not
//! retried until the demand next changes. The units run either way, as the
//! session only keeps the app alive in the background.

use std::sync::Arc;

use super::UnitRunner;
use crate::domain::session_plan::{plan_session_request_for_demand, SessionRequest};
use crate::ports::background_session_platform::BackgroundSessionPlatform;

/// Make the one request, if any, that `UnitRunner`'s latest session demand
/// calls for, then wait for the demand to change, until the runtime shuts
/// down.
///
/// The session reports its own starts and ends back to `UnitRunner`, which
/// changes the demand, so this only asks.
pub(crate) async fn follow_unit_runner_session_demand_with_platform<
    D: Clone + Send + Sync + 'static,
    P: BackgroundSessionPlatform,
>(
    unit_runner: Arc<UnitRunner<D>>,
    platform: Arc<P>,
) {
    let mut session_demand_rx = unit_runner.subscribe_session_demand();
    loop {
        let demand = *session_demand_rx.borrow_and_update();
        match plan_session_request_for_demand(demand) {
            Some(SessionRequest::Start) => {
                if let Err(error) = platform.request_session_start().await {
                    log::error!(
                        "[unit-runner] failed to request the background session's start: {error:#}"
                    );
                }
            }
            Some(SessionRequest::End) => {
                // Check again under `UnitRunner`'s lock: a unit may want to run
                // again since this demand was published.
                let session_to_end = unit_runner.mark_session_no_longer_needed();
                if session_to_end.is_some() {
                    if let Err(error) = platform.request_session_end().await {
                        log::error!(
                            "[unit-runner] failed to request the background session's end: {error:#}"
                        );
                    }
                }
            }
            None => {}
        }
        if session_demand_rx.changed().await.is_err() {
            return;
        }
    }
}
