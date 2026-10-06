//! The doubles the runner tests share: a hand-set wall clock, scripted units
//! that record their runs, a fake lease platform, and status waits.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, TimeDelta, Utc};
use tokio::sync::Barrier;

use crate::domain::lease_book::LeaseId;
use crate::domain::run_policy::RunPolicy;
use crate::run_context::RunContext;
use crate::runner::erase_factory;
use crate::runner::lease_driver::{LeaseOperation, LeasePlatform};
use crate::runner::wall_clock::WallClock;
use crate::runner::{RunnerCore, RunnerTimings};
use crate::status::{PlatformStopReason, RunState, RunStop, StopReason, UnitStatus};
use crate::unit::{Unit, UnitId};

/// How long a test waits for something that should happen promptly before it
/// fails rather than hangs.
pub(super) const PROMPTLY: Duration = Duration::from_secs(10);

/// How long a test watches for something that must not happen.
pub(super) const A_WHILE: Duration = Duration::from_millis(300);

/// The detail the scripted units report.
pub(super) type Detail = String;

/// A wall clock the test sets by hand.
pub(super) struct ManualClock(Mutex<DateTime<Utc>>);

impl ManualClock {
    pub(super) fn advance(&self, by: Duration) {
        let mut now = self.0.lock().expect("clock lock");
        *now += TimeDelta::from_std(by).expect("a short advance");
    }
}

impl WallClock for ManualClock {
    fn now(&self) -> DateTime<Utc> {
        *self.0.lock().expect("clock lock")
    }
}

/// A runner on the test's runtime, its clock, and quick timings.
pub(super) struct Harness {
    pub(super) core: Arc<RunnerCore<Detail>>,
    pub(super) clock: Arc<ManualClock>,
}

impl Harness {
    /// A runner that restarts after `restart_delay`.
    pub(super) fn with_restart_delay(restart_delay: Duration) -> Self {
        let clock = Arc::new(ManualClock(Mutex::new(
            DateTime::from_timestamp(1_800_000_000, 0).expect("a valid instant"),
        )));
        let core = RunnerCore::new(
            tokio::runtime::Handle::current(),
            Arc::clone(&clock) as Arc<dyn WallClock>,
            RunnerTimings {
                restart_delay,
                run_runtime_shutdown_timeout: Duration::from_secs(1),
                wall_clock_reconcile_interval: Duration::from_secs(10),
            },
        );
        Self { core, clock }
    }

    pub(super) fn new() -> Self {
        Self::with_restart_delay(Duration::from_millis(100))
    }

    pub(super) fn now(&self) -> DateTime<Utc> {
        self.clock.now()
    }

    /// Set `unit_id` to run `script` under `policy`, recording on `probe`.
    pub(super) fn set(&self, unit_id: &str, policy: RunPolicy, script: Script, probe: &Probe) {
        let probe = probe.clone();
        self.core.set(
            UnitId::from(unit_id),
            policy,
            erase_factory(move || {
                Ok(ScriptedUnit {
                    script: script.clone(),
                    probe: probe.clone(),
                })
            }),
        );
    }

    pub(super) fn status(&self, unit_id: &str) -> Option<UnitStatus<Detail>> {
        self.core.statuses().get(&UnitId::from(unit_id)).cloned()
    }

    /// Wait until `unit_id`'s status satisfies `predicate`, failing the test
    /// after [`PROMPTLY`].
    pub(super) async fn wait_for(
        &self,
        unit_id: &str,
        what: &str,
        predicate: impl Fn(&UnitStatus<Detail>) -> bool,
    ) -> UnitStatus<Detail> {
        let unit_id = UnitId::from(unit_id);
        let mut statuses_rx = self.core.subscribe();
        let waited = tokio::time::timeout(
            PROMPTLY,
            statuses_rx.wait_for(|statuses| statuses.get(&unit_id).is_some_and(&predicate)),
        )
        .await;
        match waited {
            Ok(Ok(statuses)) => statuses.get(&unit_id).cloned().expect("just matched"),
            Ok(Err(_)) => panic!("the statuses closed while waiting for {unit_id} to be {what}"),
            Err(_) => panic!(
                "{unit_id} never became {what}; it is {:?}",
                self.core.statuses().get(&unit_id)
            ),
        }
    }

    pub(super) async fn wait_until_running(&self, unit_id: &str) -> UnitStatus<Detail> {
        self.wait_for(unit_id, "running", |status| {
            status.run_state == RunState::Running
        })
        .await
    }

    /// Wait until `unit_id`'s latest run stopped for `reason`.
    pub(super) async fn wait_until_stopped_for(
        &self,
        unit_id: &str,
        reason: StopReason,
    ) -> RunStop {
        let status = self
            .wait_for(unit_id, &format!("stopped for {reason:?}"), |status| {
                last_stop(status).is_some_and(|stop| stop.reason == reason)
            })
            .await;
        last_stop(&status).cloned().expect("just matched")
    }
}

/// How the latest run of a status stopped, while no run is in progress.
pub(super) fn last_stop<D>(status: &UnitStatus<D>) -> Option<&RunStop> {
    match &status.run_state {
        RunState::Stopped { last_stop } => last_stop.as_ref(),
        RunState::Starting | RunState::Running => None,
    }
}

/// What a scripted unit does in each run.
#[derive(Clone)]
pub(super) enum Script {
    /// Report running and the detail, then wait to be asked to stop.
    RunUntilStopped { detail: Option<Detail> },
    /// Like `RunUntilStopped`, but take `shutdown_takes` to wind down.
    WindDownSlowly { shutdown_takes: Duration },
    /// Wait at `barrier` with the other units, then report running and wait to
    /// be asked to stop.
    MeetOthers { barrier: Arc<Barrier> },
    /// Report running and `detail`, then fail with `error`.
    Fail {
        detail: Option<Detail>,
        error: &'static str,
    },
    /// Report running, then return `Ok` without being asked to.
    Return,
    /// Panic with `message`.
    Panic { message: &'static str },
    /// Report running, hand a clone of the context to a thread that outlives
    /// the run and writes to it after `delay`, then wait to be asked to stop.
    LeakContext { delay: Duration },
}

/// What scripted units record about their runs.
#[derive(Clone, Default)]
pub(super) struct Probe {
    inner: Arc<ProbeInner>,
}

#[derive(Default)]
struct ProbeInner {
    starts: AtomicUsize,
    in_progress: AtomicUsize,
    most_in_progress: AtomicUsize,
    events: Mutex<Vec<RunEvent>>,
}

/// One thing a scripted unit's run did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum RunEvent {
    Began(UnitId),
    Ended(UnitId),
}

impl Probe {
    /// How many runs began.
    pub(super) fn starts(&self) -> usize {
        self.inner.starts.load(Ordering::SeqCst)
    }

    /// The most runs that were in progress at once.
    pub(super) fn most_in_progress(&self) -> usize {
        self.inner.most_in_progress.load(Ordering::SeqCst)
    }

    pub(super) fn events(&self) -> Vec<RunEvent> {
        self.inner.events.lock().expect("events lock").clone()
    }

    fn began(&self, unit_id: &UnitId) {
        self.inner.starts.fetch_add(1, Ordering::SeqCst);
        let in_progress = self.inner.in_progress.fetch_add(1, Ordering::SeqCst) + 1;
        self.inner
            .most_in_progress
            .fetch_max(in_progress, Ordering::SeqCst);
        self.record(RunEvent::Began(unit_id.clone()));
    }

    fn ended(&self, unit_id: &UnitId) {
        self.inner.in_progress.fetch_sub(1, Ordering::SeqCst);
        self.record(RunEvent::Ended(unit_id.clone()));
    }

    fn record(&self, event: RunEvent) {
        self.inner.events.lock().expect("events lock").push(event);
    }
}

/// A unit that follows its script and records on its probe.
pub(super) struct ScriptedUnit {
    script: Script,
    probe: Probe,
}

impl Unit for ScriptedUnit {
    type Detail = Detail;

    async fn run(self, ctx: RunContext<Detail>) -> anyhow::Result<()> {
        let unit_id = ctx.unit_id().clone();
        self.probe.began(&unit_id);
        let result = run_script(self.script, &ctx).await;
        self.probe.ended(&unit_id);
        result
    }
}

async fn run_script(script: Script, ctx: &RunContext<Detail>) -> anyhow::Result<()> {
    match script {
        Script::RunUntilStopped { detail } => {
            ctx.running();
            if let Some(detail) = detail {
                ctx.set_detail(detail);
            }
            ctx.shutdown().cancelled().await;
            Ok(())
        }
        Script::WindDownSlowly { shutdown_takes } => {
            ctx.running();
            ctx.shutdown().cancelled().await;
            tokio::time::sleep(shutdown_takes).await;
            Ok(())
        }
        Script::MeetOthers { barrier } => {
            barrier.wait().await;
            ctx.running();
            ctx.shutdown().cancelled().await;
            Ok(())
        }
        Script::Fail { detail, error } => {
            ctx.running();
            if let Some(detail) = detail {
                ctx.set_detail(detail);
            }
            Err(anyhow::anyhow!(error).context("the scripted unit failed"))
        }
        Script::Return => {
            ctx.running();
            Ok(())
        }
        Script::Panic { message } => panic!("{message}"),
        Script::LeakContext { delay } => {
            ctx.running();
            let leaked = ctx.clone();
            std::thread::spawn(move || {
                std::thread::sleep(delay);
                leaked.set_detail("written after the run".to_owned());
                leaked.running();
            });
            ctx.shutdown().cancelled().await;
            Ok(())
        }
    }
}

/// A lease platform that starts and stops a pretend lease task at once, as the
/// plugin would, and records the calls.
pub(super) struct FakeLease {
    core: Arc<RunnerCore<Detail>>,
    task: Mutex<Option<LeaseId>>,
    takes: AtomicUsize,
    releases: AtomicUsize,
}

impl FakeLease {
    pub(super) fn new(core: &Arc<RunnerCore<Detail>>) -> Arc<Self> {
        Arc::new(Self {
            core: Arc::clone(core),
            task: Mutex::new(None),
            takes: AtomicUsize::new(0),
            releases: AtomicUsize::new(0),
        })
    }

    pub(super) fn takes(&self) -> usize {
        self.takes.load(Ordering::SeqCst)
    }

    pub(super) fn releases(&self) -> usize {
        self.releases.load(Ordering::SeqCst)
    }

    pub(super) fn task_running(&self) -> bool {
        self.task.lock().expect("task lock").is_some()
    }

    /// The platform starts the lease task itself (an iOS background task, the
    /// plugin's recovery).
    pub(super) fn platform_starts(&self) {
        let mut task = self.task.lock().expect("task lock");
        if task.is_none() {
            *task = Some(self.core.lease_gained());
        }
    }

    /// The platform ends the lease task, for `reason`.
    pub(super) fn platform_ends(&self, reason: PlatformStopReason) {
        let ended = self.task.lock().expect("task lock").take();
        if let Some(lease) = ended {
            self.core.lease_ended(lease, Some(reason));
        }
    }
}

impl LeasePlatform for FakeLease {
    fn take(&self) -> LeaseOperation<'_> {
        Box::pin(async move {
            self.takes.fetch_add(1, Ordering::SeqCst);
            self.platform_starts();
            Ok(())
        })
    }

    fn release(&self) -> LeaseOperation<'_> {
        Box::pin(async move {
            self.releases.fetch_add(1, Ordering::SeqCst);
            let ended = self.task.lock().expect("task lock").take();
            if let Some(lease) = ended {
                self.core.lease_ended(lease, None);
            }
            Ok(())
        })
    }
}

/// Wait until `condition` holds, failing the test after [`PROMPTLY`].
pub(super) async fn eventually(what: &str, condition: impl Fn() -> bool) {
    let waited = tokio::time::timeout(PROMPTLY, async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert!(waited.is_ok(), "never: {what}");
}
