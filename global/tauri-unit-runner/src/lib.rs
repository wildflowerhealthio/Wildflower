//! Runs a Tauri app's long-lived background work as **units**: the Tauri
//! bindings of [`unit_runner`].
//!
//! The app gives the [`UnitRunner`] each unit's id, [`RunPolicy`] and factory.
//! The runner starts and stops units to match their policies, restarts the ones
//! that end on their own, keeps the app alive with one background-service
//! **keep-alive** task for all of them, and reports each unit's
//! [`UnitStatus`]. It knows nothing about what a unit does. The units, the
//! policies and the reconcile are `unit-runner`'s; see its Design Explanation
//! for the design, and this crate's
//! [Design Explanation](../docs/Design%20Explanation.md) for the Tauri side.
//!
//! Every public type of `unit-runner` is re-exported here, so an app needs
//! only this crate; its domain crates can depend on `unit-runner` alone.
//!
//! Layered so everything that decides is testable without a webview:
//!
//!  - `domain` — the one Tauri-side rule: whether the app is open after each
//!    window event, and which resumes restart every running unit.
//!  - `runner` — [`UnitRunner`]: a [`UnitRunnerCore`] on Tauri's async
//!    runtime, with the Tauri side's state.
//!  - `tauri_bindings` — the core's [`KeepAlivePlatform`] port bound to
//!    `tauri-plugin-background-service`, and the app's window events, as the
//!    two plugins the app registers.

mod domain;
mod runner;
mod tauri_bindings;

pub use runner::UnitRunner;
pub use tauri_bindings::{KEEP_ALIVE_END_REASON_WAIT, UNIT_RUNNER_PLUGIN_NAME};
pub use tauri_plugin_background_service::StartConfig as BackgroundServiceStartConfig;
pub use unit_runner::{
    KeepAliveId, KeepAliveOperation, KeepAlivePlatform, PlatformStopReason, RunContext, RunPolicy,
    RunState, RunStop, StopReason, SystemClock, Unit, UnitId, UnitRunnerCore, UnitStatus,
    UnitStatuses, WallClock, RESTART_DELAY, RUN_RUNTIME_SHUTDOWN_TIMEOUT,
    WALL_CLOCK_RECONCILE_INTERVAL, WHILE_OPEN_GRACE,
};
