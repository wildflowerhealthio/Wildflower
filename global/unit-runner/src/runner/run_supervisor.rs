//! One run of a unit, from its run gate to its `Stopped`: what `UnitRunner`
//! spawns for each run it starts.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;

use super::dedicated_runtime::run_on_dedicated_thread;
use super::erased_unit::UnitFactory;
use super::run_stop_signal::RunStopSignal;
use super::unit_entry::RunGeneration;
use super::unit_run_gate::UnitRunGate;
use super::UnitRunner;
use crate::status::StopReason;
use crate::unit::UnitId;

/// Everything one run needs, fixed when `UnitRunner` starts it.
pub(crate) struct SuperviseRunArgs<D> {
    pub(crate) unit_id: UnitId,
    pub(crate) generation: RunGeneration,
    pub(crate) factory: UnitFactory<D>,
    pub(crate) gate: UnitRunGate,
    pub(crate) stop_signal: RunStopSignal,
    /// How long the run's runtime waits for the unit's tasks once its run
    /// returns.
    pub(crate) shutdown_timeout: Duration,
    pub(crate) run_finished_tx: watch::Sender<bool>,
}

/// Run `args`' unit once:
///
///  1. Wait at the unit's run gate for its previous run to end.
///  2. Publish `Starting`.
///  3. Run the unit on its own thread and runtime, until that runtime is gone.
///  4. Record the run's end with `UnitRunner`,
///  5. then publish `Stopped`, with the run's stop reason and error.
///  6. Open the gate for the unit's next run.
///
/// A run asked to stop while it waits at the gate never starts and publishes
/// nothing; it still waits its turn, so its end implies its predecessors'.
pub(crate) async fn supervise_run<D: Clone + Send + Sync + 'static>(
    unit_runner: Arc<UnitRunner<D>>,
    args: SuperviseRunArgs<D>,
) {
    let SuperviseRunArgs {
        unit_id,
        generation,
        factory,
        gate,
        stop_signal,
        shutdown_timeout,
        run_finished_tx,
    } = args;

    // 1. Wait at the unit's gate.
    let run_gate_guard = gate.wait_for_previous_run().await;
    // Before the run starts, only `UnitRunner` stops it, and it sets the stop
    // reason before it cancels the shutdown token. So a reason set by now
    // means the run was stopped while it waited.
    if let Some(reason) = stop_signal.stop_reason() {
        unit_runner.run_finished_before_starting(&unit_id, generation, reason);
        drop(run_gate_guard);
        run_finished_tx.send_replace(true);
        return;
    }

    // 2. Publish `Starting`.
    let run_liveness = unit_runner.run_admitted(&unit_id);

    // 3. Run the unit on its own thread and runtime.
    let ctx = unit_runner.context_for_run(
        unit_id.clone(),
        stop_signal.shutdown_token().clone(),
        run_liveness.clone(),
    );
    let result = run_on_dedicated_thread(factory, ctx, shutdown_timeout).await;
    // A run nothing asked to stop ended on its own.
    let reason = stop_signal.request_stop(StopReason::EndedOnItsOwn);
    let error = result.err().map(|error| format!("{error:#}"));
    if let Some(error) = &error {
        log::warn!("[unit-runner] {unit_id} stopped ({reason:?}) with an error: {error}");
    } else {
        log::info!("[unit-runner] {unit_id} stopped ({reason:?})");
    }

    // 4–5. Record the end (scheduling a restart, or starting the next run
    // behind the gate), then publish `Stopped`.
    unit_runner.run_finished(&unit_id, generation, &run_liveness, reason, error);

    // 6. Open the gate.
    drop(run_gate_guard);
    run_finished_tx.send_replace(true);
}
