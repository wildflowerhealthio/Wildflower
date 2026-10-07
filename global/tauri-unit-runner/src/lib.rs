//! Runs a Tauri app's long-lived background work as **units**: the Tauri
//! bindings of [`unit_runner`].
//!
//! The app gives the [`TauriUnitRunner`] each unit's id, [`RunPolicy`] and
//! factory. `TauriUnitRunner` starts and stops units to match their policies,
//! restarts the ones that end on their own, keeps the app alive in the
//! background with one **background session** of the background-service plugin
//! for all of them, and reports each unit's [`UnitStatus`]. It knows nothing
//! about what a unit does. The units, the policies, and starting and stopping
//! runs per policy are `unit-runner`'s; see its Design Explanation for the
//! design, and this crate's [Design
//! Explanation](../docs/Design%20Explanation.md) for the Tauri side.
//!
//! Every public type of `unit-runner` is re-exported here, so an app needs
//! only this crate; its domain crates can depend on `unit-runner` alone.
//!
//! Layered so everything that decides is testable without a webview:
//!
//!  - `domain` — the one Tauri-side rule: whether the app is present after
//!    each window event, and which returns to the foreground restart every
//!    running unit.
//!  - `runner` — [`TauriUnitRunner`]: a [`UnitRunner`] on Tauri's async
//!    runtime, with the Tauri side's state.
//!  - `tauri_bindings` — `UnitRunner`'s [`BackgroundSessionPlatform`] port
//!    bound to `tauri-plugin-background-service`, and the app's window events,
//!    as the two plugins the app registers.

mod domain;
mod tauri_bindings;
mod tauri_unit_runner;

pub use tauri_bindings::{SESSION_END_REASON_WAIT, UNIT_RUNNER_PLUGIN_NAME};
pub use tauri_plugin_background_service::StartConfig as BackgroundServiceStartConfig;
pub use tauri_unit_runner::TauriUnitRunner;
pub use unit_runner::{
    BackgroundSessionOperation, BackgroundSessionPlatform, PlatformStopReason, RunContext,
    RunPolicy, RunState, RunStop, SessionId, StopReason, SystemClock, Unit, UnitId, UnitRunner,
    UnitStatus, UnitStatuses, WallClock, RESTART_DELAY, RUN_RUNTIME_SHUTDOWN_TIMEOUT,
    START_AND_STOP_RUNS_PER_POLICY_INTERVAL, WHILE_OPEN_GRACE,
};
