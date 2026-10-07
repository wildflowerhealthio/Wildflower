//! Runs an app's long-lived background work as **units**, on any platform.
//!
//! The app gives [`UnitRunner`] each unit's id, [`RunPolicy`] and factory.
//! `UnitRunner` starts and stops units to match their policies, restarts the
//! ones that end on their own, asks the platform for one **background session**
//! while any of them should run, and reports each unit's [`UnitStatus`]. It
//! knows nothing about what a unit does. See the [Design
//! Explanation](../docs/Design%20Explanation.md).
//!
//! This crate has no platform dependency, so an app's domain crates can define
//! units and store run policies without depending on Tauri. A host crate, such
//! as `tauri-unit-runner`, binds [`UnitRunner`] to its platform through the
//! [`BackgroundSessionPlatform`] port and `UnitRunner`'s host calls.
//!
//! Layered so everything that decides is testable without a platform:
//!
//!  - `domain` — the pure rules: when a policy wants a unit running, when the
//!    app counts as present, what starting and stopping runs per policy does
//!    to each unit, when a run restarts, and how a background session ends.
//!  - `ports` — what `UnitRunner` needs from its host: the [`WallClock`] and
//!    the [`BackgroundSessionPlatform`].
//!  - `runner` — [`UnitRunner`]'s state, each run's thread and runtime,
//!    the run gates, the statuses and the background session's demand.

mod domain;
mod ports;
mod run_context;
mod runner;
mod status;
mod unit;

pub use domain::app_presence::WHILE_OPEN_GRACE;
pub use domain::run_policy::RunPolicy;
pub use domain::session_ledger::SessionId;
pub use ports::background_session_platform::{
    BackgroundSessionOperation, BackgroundSessionPlatform,
};
pub use ports::wall_clock::{SystemClock, WallClock};
pub use run_context::RunContext;
pub use runner::{
    UnitRunner, RESTART_DELAY, RUN_RUNTIME_SHUTDOWN_TIMEOUT,
    START_AND_STOP_RUNS_PER_POLICY_INTERVAL,
};
pub use status::{PlatformStopReason, RunState, RunStop, StopReason, UnitStatus, UnitStatuses};
pub use unit::{Unit, UnitId};
