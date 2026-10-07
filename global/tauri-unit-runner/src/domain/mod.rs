//! The runner's rules, free of threads, runtimes and Tauri: when a policy is
//! active, when the app counts as open, what a reconcile does to each unit,
//! when a run restarts, and how a keep-alive task ends. Every rule takes the
//! wall-clock instant it is judged at, so tests drive it with a fixed clock.

pub mod app_presence;
pub mod keep_alive_ledger;
pub mod run_policy;
pub mod unit_plan;
pub mod window_state;
