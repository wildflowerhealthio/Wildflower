//! `UnitRunner`'s rules, free of threads, runtimes and platforms: when a policy
//! is active, when the app counts as open, what a reconcile does to each unit,
//! when a run restarts, and how a background session ends. Every rule takes the
//! wall-clock instant it is judged at, so tests drive it with a fixed clock.

pub mod app_presence;
pub mod run_policy;
pub mod session_ledger;
pub mod unit_plan;
