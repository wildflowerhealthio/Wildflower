//! One run of a unit, from its run gate to its `Stopped`: what the runner
//! spawns for each run it starts.

use std::sync::{Arc, OnceLock};

use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::dedicated_runtime::run_on_dedicated_thread;
use super::erased_unit::UnitFactory;
use super::run_gate::RunGate;
use super::status_board::RunLiveness;
use super::UnitRunnerCore;
use crate::run_context::RunContext;
use crate::status::StopReason;
use crate::unit::UnitId;

/// Everything one run needs, fixed when the runner starts it.
pub(crate) struct RunSpec<D> {
    pub(crate) unit_id: UnitId,
    pub(crate) generation: u64,
    pub(crate) factory: UnitFactory<D>,
    pub(crate) gate: RunGate,
    pub(crate) shutdown: CancellationToken,
    pub(crate) stop_reason: Arc<OnceLock<StopReason>>,
    pub(crate) finished_tx: watch::Sender<bool>,
}

/// Run `spec`'s unit once.
///
/// Waits at the unit's run gate for its previous run to end, then publishes
/// `Starting` and runs the unit on its own thread and runtime. Once that
/// runtime is gone it tells the runner the run ended, publishes `Stopped` with
/// the run's stop reason and error, and opens the gate.
///
/// A run asked to stop while it waits at the gate never starts and publishes
/// nothing; it still waits its turn, so its end implies its predecessors'.
pub(crate) async fn supervise_run<D: Clone + Send + Sync + 'static>(
    core: Arc<UnitRunnerCore<D>>,
    spec: RunSpec<D>,
) {
    let RunSpec {
        unit_id,
        generation,
        factory,
        gate,
        shutdown,
        stop_reason,
        finished_tx,
    } = spec;
    let run_gate_guard = gate.wait_for_previous_run().await;
    // Before the run starts, only the runner stops it, and it sets the stop
    // reason before it cancels `shutdown`. So a reason set by now means the
    // run was stopped while it waited.
    if let Some(&reason) = stop_reason.get() {
        drop(run_gate_guard);
        core.run_ended(&unit_id, generation, reason);
        finished_tx.send_replace(true);
        return;
    }

    let run = RunLiveness::default();
    core.board().publish_starting(&unit_id, &run);
    let ctx = RunContext::new(unit_id.clone(), shutdown, core.board().clone(), run.clone());
    let result =
        run_on_dedicated_thread(factory, ctx, core.timings().run_runtime_shutdown_timeout).await;
    let reason = *stop_reason.get_or_init(|| StopReason::EndedOnItsOwn);
    let error = result.err().map(|error| format!("{error:#}"));
    if let Some(error) = &error {
        log::warn!("[unit-runner] {unit_id} stopped ({reason:?}) with an error: {error}");
    } else {
        log::info!("[unit-runner] {unit_id} stopped ({reason:?})");
    }
    // The runner records the end (scheduling a restart, or starting the next
    // run behind the gate) before anyone can see `Stopped`, so whatever the
    // app does on seeing it, a `set_unit_policy` included, acts on a run that
    // has ended.
    core.run_ended(&unit_id, generation, reason);
    core.board().publish_stopped(&unit_id, &run, reason, error);
    drop(run_gate_guard);
    finished_tx.send_replace(true);
}
