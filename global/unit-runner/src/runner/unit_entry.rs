//! [`UnitEntry`], the runner's record of one unit: its policy, its factory, its
//! run gate, its current run and its pending restart.

use std::sync::{Arc, OnceLock};

use chrono::{DateTime, Utc};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::erased_unit::UnitFactory;
use super::run_gate::RunGate;
use crate::domain::run_policy::RunPolicy;
use crate::domain::unit_plan::UnitPhase;
use crate::status::StopReason;

/// The runner's record of one unit.
pub(crate) struct UnitEntry<D> {
    pub(crate) policy: RunPolicy,
    pub(crate) factory: UnitFactory<D>,
    /// Shared by every run of the unit, the next one included after a
    /// `set_unit`, or a `remove_unit` that the app undoes with a `set_unit`.
    pub(crate) gate: RunGate,
    /// The latest run, until it has ended.
    pub(crate) run: Option<ActiveRun>,
    pub(crate) pending_restart: Option<PendingRestart>,
    /// `remove_unit` is waiting for the unit's run to end before forgetting
    /// it.
    pub(crate) removing: bool,
}

impl<D> UnitEntry<D> {
    pub(crate) fn new(policy: RunPolicy, factory: UnitFactory<D>) -> Self {
        Self {
            policy,
            factory,
            gate: RunGate::default(),
            run: None,
            pending_restart: None,
            removing: false,
        }
    }

    /// Whether the unit should run at the wall-clock instant `now`, given
    /// whether the app is open or within its grace period and whether the
    /// platform revoked the keep-alive. A unit being removed never should, and
    /// no unit should while the keep-alive is revoked.
    pub(crate) fn should_run(
        &self,
        now: DateTime<Utc>,
        app_open_or_in_grace: bool,
        keep_alive_revoked: bool,
    ) -> bool {
        !self.removing && !keep_alive_revoked && self.policy.is_active(now, app_open_or_in_grace)
    }

    /// Where the unit is, as a reconcile sees it.
    pub(crate) fn phase(&self) -> UnitPhase {
        match (&self.run, &self.pending_restart) {
            (Some(run), _) if run.stop_requested() => UnitPhase::Stopping,
            (Some(_), _) => UnitPhase::Running,
            (None, Some(_)) => UnitPhase::RestartPending,
            (None, None) => UnitPhase::Idle,
        }
    }

    /// Ask the unit's run, if it has one, to stop for `reason`.
    pub(crate) fn stop_run(&self, reason: StopReason) {
        if let Some(run) = &self.run {
            run.request_stop(reason);
        }
    }
}

/// A run that has begun and not yet ended.
pub(crate) struct ActiveRun {
    /// Tells this run's end from a later run's.
    pub(crate) generation: u64,
    pub(crate) shutdown: CancellationToken,
    /// Why the run stopped: set once, by whoever is first, the runner asking
    /// it to stop or the run ending on its own.
    pub(crate) stop_reason: Arc<OnceLock<StopReason>>,
    /// `true` once the run's thread and runtime are gone and the runner has
    /// recorded its end.
    pub(crate) finished_rx: watch::Receiver<bool>,
}

impl ActiveRun {
    /// Ask the run to stop for `reason`. A run that already has a stop reason
    /// keeps it.
    pub(crate) fn request_stop(&self, reason: StopReason) {
        // A run asked twice keeps the first reason.
        let _first_reason_kept = self.stop_reason.set(reason);
        self.shutdown.cancel();
    }

    pub(crate) fn stop_requested(&self) -> bool {
        self.stop_reason.get().is_some()
    }
}

/// A restart waiting out the restart delay.
pub(crate) struct PendingRestart {
    /// Tells this restart's timer from a cancelled one's.
    pub(crate) generation: u64,
}
