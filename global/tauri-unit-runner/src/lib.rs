//! Runs a Tauri app's long-lived background work as **units**.
//!
//! The app gives the [`UnitRunner`] each unit's id, [`RunPolicy`] and factory.
//! The runner starts and stops units to match their policies, restarts the ones
//! that end on their own, keeps the app alive with one background-service
//! **keep-alive** task for all of them, and reports each unit's
//! [`UnitStatus`]. It knows nothing about what a unit does. See the
//! [Design Explanation](../docs/Design%20Explanation.md).
//!
//! Layered so everything that decides is testable without a webview:
//!
//!  - `domain` — the pure rules: when a policy is active, when the app counts
//!    as open, what a reconcile does to each unit, when a run restarts, and
//!    how a keep-alive task ends.
//!  - `runner` — [`UnitRunner`]'s state, each run's thread and runtime, the run
//!    gates, the statuses and the keep-alive demand, behind a small keep-alive
//!    seam.
//!  - `tauri_bindings` — the seam bound to `tauri-plugin-background-service`
//!    and the app's window events, as two plugins the app registers.

mod domain;
mod run_context;
mod runner;
mod status;
mod tauri_bindings;
mod unit;
mod unit_runner;

pub use domain::app_presence::WHILE_OPEN_GRACE;
pub use domain::run_policy::RunPolicy;
pub use run_context::RunContext;
pub use runner::{RESTART_DELAY, RUN_RUNTIME_SHUTDOWN_TIMEOUT, WALL_CLOCK_RECONCILE_INTERVAL};
pub use status::{PlatformStopReason, RunState, RunStop, StopReason, UnitStatus, UnitStatuses};
pub use tauri_bindings::{KEEP_ALIVE_END_REASON_WAIT, UNIT_RUNNER_PLUGIN_NAME};
pub use tauri_plugin_background_service::StartConfig;
pub use unit::{Unit, UnitId};
pub use unit_runner::UnitRunner;
