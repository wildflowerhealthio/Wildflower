//! What `UnitRunner` reports for each unit: its [`UnitStatus`], made of the
//! [`RunState`] of its latest run, how that run stopped, and the unit's detail.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};

use crate::unit::UnitId;

/// Every unit's status, keyed by unit id.
pub type UnitStatuses<D> = BTreeMap<UnitId, UnitStatus<D>>;

/// What `UnitRunner` reports for one unit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnitStatus<D> {
    /// Where the unit's latest run is.
    pub run_state: RunState,
    /// When the current run called
    /// [`RunContext::announce_running`](crate::RunContext::announce_running);
    /// `None` unless the run state is [`RunState::Running`].
    pub running_since: Option<DateTime<Utc>>,
    /// The unit's own status, as the current run last set it; `None` before
    /// the run sets one and whenever no run is in progress.
    pub detail: Option<D>,
}

impl<D> UnitStatus<D> {
    /// The status of a unit that has never run.
    #[must_use]
    pub fn never_run() -> Self {
        Self {
            run_state: RunState::Stopped { last_stop: None },
            running_since: None,
            detail: None,
        }
    }
}

/// Where a unit's latest run is. A unit's run state never goes backwards
/// within a run: `Starting` → `Running` → `Stopped`, or `Starting` → `Stopped`
/// when the run ends before it is up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunState {
    /// A run has begun and its unit is starting up.
    Starting,
    /// The run's unit has called
    /// [`RunContext::announce_running`](crate::RunContext::announce_running).
    Running,
    /// No run is in progress. `last_stop` is how the latest run stopped, or
    /// `None` when the unit has never run. A run stopped while it waits for
    /// its unit's previous run never starts and changes nothing here.
    Stopped { last_stop: Option<RunStop> },
}

/// How a run stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunStop {
    /// Why the run stopped.
    pub reason: StopReason,
    /// The run's failure as its `{:#}` anyhow chain, a panic's message
    /// included; `None` when the unit returned `Ok`.
    pub error: Option<String>,
    /// When the run's runtime was gone.
    pub stopped_at: DateTime<Utc>,
}

/// Why a run stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// `UnitRunner` stopped the run because the unit's policy stopped being
    /// active: the app set another policy, an `Until` ran out, or the app's
    /// grace period ended. Starts again only once the policy is active again.
    PolicyInactive,
    /// The app set the unit again, so `UnitRunner` stopped the run of the old
    /// definition. The new definition starts once this run has ended, if it
    /// should run.
    Replaced,
    /// The app removed the unit, so `UnitRunner` stopped its run.
    Removed,
    /// `UnitRunner` stopped the run to start it again at once: the host
    /// restarted every running unit, as the Tauri host does on an iOS resume.
    /// The unit starts again once this run has ended, with no restart delay,
    /// if it should still run.
    StoppedForRestart,
    /// The run ended without being asked to: its unit returned (`Ok` or an
    /// error), its factory failed, or it panicked. Restarted after
    /// [`RESTART_DELAY`](crate::RESTART_DELAY) while the unit should still run.
    EndedOnItsOwn,
    /// The platform ended the background session, for `platform_reason`. Not
    /// restarted until the app opens again, the app sets a policy, or a
    /// session starts again.
    SessionEndedByPlatform {
        /// The platform's reason for ending the background session.
        platform_reason: PlatformStopReason,
    },
}

/// Why the platform ended the background session, in the words of
/// `tauri-plugin-background-service`, the one background session platform
/// `UnitRunner` is bound to. `UnitRunner`'s own ends of the session never
/// appear here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PlatformStopReason {
    /// A stop through the plugin's own `stop`, the desktop app quitting
    /// included.
    UserStop,
    /// The platform's foreground-service time limit ran out (Android).
    PlatformTimeout,
    /// The platform ended the background execution window (iOS).
    PlatformExpiration,
    /// The Stop action on the foreground-service notification (Android).
    NativeNotificationStop,
    /// The OS restarted the service.
    OsRestart,
    /// The service came back after the device booted.
    BootRecovery,
    /// The background session's task ended with no stop pending.
    TaskCompleted,
    /// The plugin reported the background session's task as failed.
    Error,
    /// The app's process is going away (the iOS app backgrounded or killed).
    ProcessExit,
    /// The plugin gave no reason `UnitRunner` knows, or none arrived in time
    /// (`tauri-unit-runner`'s `SESSION_END_REASON_WAIT`).
    Unknown,
}
