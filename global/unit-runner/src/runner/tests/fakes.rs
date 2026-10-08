//! The doubles the `UnitRunner` tests share: a hand-set wall clock, scripted
//! units that record their runs, a fake background session platform, and status
//! waits.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, TimeDelta, Utc};
use tokio::sync::{Barrier, Semaphore};

use crate::domain::run_policy::RunPolicy;
use crate::domain::session_ledger::SessionId;
use crate::domain::session_plan::SessionDemand;
use crate::domain::unit_plan::UnitPhase;
use crate::ports::background_session_platform::BackgroundSessionPlatform;
use crate::ports::wall_clock::WallClock;
use crate::run_context::RunContext;
use crate::runner::{RunnerTimings, UnitRunner, MAX_RESTART_DELAY};
use crate::status::{PlatformStopReason, RunState, RunStop, StopReason, UnitStatus};
use crate::unit::{Unit, UnitId};

/// The ceiling on a test's wait for something that should happen, so a broken
/// `UnitRunner` fails the test rather than hangs it.
pub(super) const HANG_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a test watches for something that must not happen, where nothing
/// marks the moment it would have happened. Most checks for what must not
/// happen read `UnitRunner`'s state instead (see [`Harness::phase`]).
pub(super) const QUIET_PERIOD: Duration = Duration::from_millis(300);

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

/// A `UnitRunner` on the test's runtime, its clock, and quick timings.
pub(super) struct Harness {
    pub(super) unit_runner: Arc<UnitRunner<Detail>>,
    pub(super) clock: Arc<ManualClock>,
}

impl Harness {
    /// A `UnitRunner` that first restarts after `restart_delay`, backing off
    /// to [`MAX_RESTART_DELAY`].
    pub(super) fn with_restart_delay(restart_delay: Duration) -> Self {
        Self::with_restart_delays(restart_delay, MAX_RESTART_DELAY)
    }

    /// A `UnitRunner` that first restarts after `restart_delay`, backing off
    /// to `max_restart_delay`.
    pub(super) fn with_restart_delays(
        restart_delay: Duration,
        max_restart_delay: Duration,
    ) -> Self {
        let clock = Arc::new(ManualClock(Mutex::new(
            DateTime::from_timestamp(1_800_000_000, 0).expect("a valid instant"),
        )));
        let unit_runner = UnitRunner::with_timings(
            tokio::runtime::Handle::current(),
            Arc::clone(&clock) as Arc<dyn WallClock>,
            RunnerTimings {
                restart_delay,
                max_restart_delay,
                run_runtime_shutdown_timeout: Duration::from_secs(1),
                start_and_stop_runs_per_policy_interval: Duration::from_secs(10),
            },
        );
        Self { unit_runner, clock }
    }

    pub(super) fn new() -> Self {
        Self::with_restart_delay(Duration::from_millis(100))
    }

    pub(super) fn now(&self) -> DateTime<Utc> {
        self.clock.now()
    }

    /// Set `unit_id` to run `script` under `policy`, recording on `probe`.
    pub(super) fn set_unit(&self, unit_id: &str, policy: RunPolicy, script: Script, probe: &Probe) {
        let probe = probe.clone();
        self.unit_runner
            .set_unit(UnitId::from(unit_id), policy, move || {
                Ok(ScriptedUnit {
                    script: script.clone(),
                    probe: probe.clone(),
                })
            });
    }

    pub(super) fn set_unit_policy(&self, unit_id: &str, policy: RunPolicy) {
        self.unit_runner
            .set_unit_policy(&UnitId::from(unit_id), policy);
    }

    pub(super) fn status(&self, unit_id: &str) -> Option<UnitStatus<Detail>> {
        self.unit_runner
            .statuses()
            .get(&UnitId::from(unit_id))
            .cloned()
    }

    /// Where `unit_id` is, as starting and stopping runs per policy sees it,
    /// right now. Every
    /// `UnitRunner` call that changes it has done so by the time it returns, so
    /// a test can read it to check that something didn't happen.
    pub(super) fn phase(&self, unit_id: &str) -> Option<UnitPhase> {
        self.unit_runner.unit_phase(&UnitId::from(unit_id))
    }

    /// `UnitRunner`'s background session demand right now.
    pub(super) fn session_demand(&self) -> SessionDemand {
        *self.unit_runner.subscribe_session_demand().borrow()
    }

    /// Wait until `unit_id`'s status satisfies `predicate`, failing the test
    /// after [`HANG_TIMEOUT`].
    pub(super) async fn wait_for(
        &self,
        unit_id: &str,
        what: &str,
        predicate: impl Fn(&UnitStatus<Detail>) -> bool,
    ) -> UnitStatus<Detail> {
        let unit_id = UnitId::from(unit_id);
        let mut statuses_rx = self.unit_runner.subscribe();
        let waited = tokio::time::timeout(
            HANG_TIMEOUT,
            statuses_rx.wait_for(|statuses| statuses.get(&unit_id).is_some_and(&predicate)),
        )
        .await;
        match waited {
            Ok(Ok(statuses)) => statuses.get(&unit_id).cloned().expect("just matched"),
            Ok(Err(_)) => panic!("the statuses closed while waiting for {unit_id} to be {what}"),
            Err(_) => panic!(
                "{unit_id} never became {what}; it is {:?}",
                self.unit_runner.statuses().get(&unit_id)
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
    /// Report running, and once asked to stop, wind down only when the test
    /// adds a permit to `allow_wind_down`.
    WindDownWhenAllowed { allow_wind_down: Arc<Semaphore> },
    /// Wait at `barrier` with the other units, then report running and wait to
    /// be asked to stop.
    MeetOthers { barrier: Arc<Barrier> },
    /// Report running and `detail`, then fail with `error`.
    Fail {
        detail: Option<Detail>,
        error: &'static str,
    },
    /// Report running if `announces_running` is set, then fail with `error`
    /// once the test adds a permit to `allow_failure`, or return `Ok` once
    /// asked to stop.
    FailWhenAllowed {
        announces_running: Arc<AtomicBool>,
        allow_failure: Arc<Semaphore>,
        error: &'static str,
    },
    /// Report running, then return `Ok` without being asked to.
    Return,
    /// Panic with `message`.
    Panic { message: &'static str },
    /// Report running, hand a clone of the context to a thread that outlives
    /// the run, then wait to be asked to stop. The thread writes to the
    /// context once the test sets `leaked.write_now`, then sets
    /// `leaked.written`.
    LeakContext { leaked: Arc<LeakedContextSignals> },
}

/// When a leaked context is written to, and that it has been.
#[derive(Default)]
pub(super) struct LeakedContextSignals {
    pub(super) write_now: AtomicBool,
    pub(super) written: AtomicBool,
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
            ctx.announce_running();
            if let Some(detail) = detail {
                ctx.set_detail(detail);
            }
            ctx.shutdown_token().cancelled().await;
            Ok(())
        }
        Script::WindDownSlowly { shutdown_takes } => {
            ctx.announce_running();
            ctx.shutdown_token().cancelled().await;
            tokio::time::sleep(shutdown_takes).await;
            Ok(())
        }
        Script::WindDownWhenAllowed { allow_wind_down } => {
            ctx.announce_running();
            ctx.shutdown_token().cancelled().await;
            let _permit = allow_wind_down.acquire().await?;
            Ok(())
        }
        Script::MeetOthers { barrier } => {
            barrier.wait().await;
            ctx.announce_running();
            ctx.shutdown_token().cancelled().await;
            Ok(())
        }
        Script::Fail { detail, error } => {
            ctx.announce_running();
            if let Some(detail) = detail {
                ctx.set_detail(detail);
            }
            Err(anyhow::anyhow!(error).context("the scripted unit failed"))
        }
        Script::FailWhenAllowed {
            announces_running,
            allow_failure,
            error,
        } => {
            if announces_running.load(Ordering::SeqCst) {
                ctx.announce_running();
            }
            tokio::select! {
                permit = allow_failure.acquire() => {
                    // Each failure uses up its permit.
                    permit?.forget();
                    Err(anyhow::anyhow!(error).context("the scripted unit failed"))
                }
                () = ctx.shutdown_token().cancelled() => Ok(()),
            }
        }
        Script::Return => {
            ctx.announce_running();
            Ok(())
        }
        Script::Panic { message } => panic!("{message}"),
        Script::LeakContext { leaked } => {
            ctx.announce_running();
            let leaked_ctx = ctx.clone();
            std::thread::spawn(move || {
                while !leaked.write_now.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(5));
                }
                leaked_ctx.set_detail("written after the run".to_owned());
                leaked_ctx.announce_running();
                leaked.written.store(true, Ordering::SeqCst);
            });
            ctx.shutdown_token().cancelled().await;
            Ok(())
        }
    }
}

/// A background session platform that starts and ends a pretend session at
/// once, as the plugin would, and records the calls.
pub(super) struct FakeBackgroundSession {
    unit_runner: Arc<UnitRunner<Detail>>,
    session: Mutex<Option<SessionId>>,
    /// Asked to end, the session keeps running until
    /// [`finish_ending_session`](Self::finish_ending_session).
    ends_held: AtomicBool,
    session_start_requests: AtomicUsize,
    session_end_requests: AtomicUsize,
}

impl FakeBackgroundSession {
    pub(super) fn new(unit_runner: &Arc<UnitRunner<Detail>>) -> Arc<Self> {
        Arc::new(Self {
            unit_runner: Arc::clone(unit_runner),
            session: Mutex::new(None),
            ends_held: AtomicBool::new(false),
            session_start_requests: AtomicUsize::new(0),
            session_end_requests: AtomicUsize::new(0),
        })
    }

    /// How many times `UnitRunner` asked for a session to start.
    pub(super) fn session_start_requests(&self) -> usize {
        self.session_start_requests.load(Ordering::SeqCst)
    }

    /// How many times `UnitRunner` asked for the session to end.
    pub(super) fn session_end_requests(&self) -> usize {
        self.session_end_requests.load(Ordering::SeqCst)
    }

    pub(super) fn session_running(&self) -> bool {
        self.session.lock().expect("session lock").is_some()
    }

    /// The platform starts a session itself (an iOS background task, the
    /// plugin's recovery).
    pub(super) fn platform_starts_session(&self) {
        let mut session = self.session.lock().expect("session lock");
        if session.is_none() {
            *session = Some(self.unit_runner.session_started());
        }
    }

    /// From now on, a session asked to end keeps running until
    /// [`finish_ending_session`](Self::finish_ending_session), as the plugin's
    /// service does until its task returns.
    pub(super) fn hold_ends(&self) {
        self.ends_held.store(true, Ordering::SeqCst);
    }

    /// The session asked to end finishes ending.
    pub(super) fn finish_ending_session(&self) {
        self.end_session();
    }

    fn end_session(&self) {
        let ended = self.session.lock().expect("session lock").take();
        if let Some(id) = ended {
            self.unit_runner.session_ended(id, None);
        }
    }

    /// The platform ends the session, for `reason`.
    pub(super) fn platform_ends_session(&self, reason: PlatformStopReason) {
        let ended = self.session.lock().expect("session lock").take();
        if let Some(id) = ended {
            self.unit_runner.session_ended(id, Some(reason));
        }
    }
}

impl BackgroundSessionPlatform for FakeBackgroundSession {
    async fn request_session_start(&self) -> anyhow::Result<()> {
        self.session_start_requests.fetch_add(1, Ordering::SeqCst);
        self.platform_starts_session();
        Ok(())
    }

    async fn request_session_end(&self) -> anyhow::Result<()> {
        self.session_end_requests.fetch_add(1, Ordering::SeqCst);
        if !self.ends_held.load(Ordering::SeqCst) {
            self.end_session();
        }
        Ok(())
    }
}

/// Wait until `condition` holds, on a test runtime whose clock is paused,
/// failing the test after [`HANG_TIMEOUT`] of real time. The wait never lets
/// the paused clock jump ahead to the next timer, as [`eventually`]'s sleeps
/// would while a run's thread works, so only the test's
/// `tokio::time::advance` moves it.
pub(super) async fn eventually_on_the_paused_clock(what: &str, condition: impl Fn() -> bool) {
    let waiting_since = std::time::Instant::now();
    while !condition() {
        assert!(waiting_since.elapsed() < HANG_TIMEOUT, "never: {what}");
        // A yield leaves the runtime with work to do, so it polls its timers
        // and the runs' wakeups without advancing the paused clock.
        tokio::task::yield_now().await;
    }
}

/// Wait until `condition` holds, failing the test after [`HANG_TIMEOUT`].
pub(super) async fn eventually(what: &str, condition: impl Fn() -> bool) {
    let waited = tokio::time::timeout(HANG_TIMEOUT, async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert!(waited.is_ok(), "never: {what}");
}
