//! `UnitRunner`'s rules, free of threads, runtimes and platforms: when a policy
//! wants a unit running, when the app counts as present, what starting and
//! stopping runs per policy does to each unit, when a run restarts, how a
//! background session ends, and when to ask the platform for a session's start
//! or end. Every rule takes the wall-clock instant it is judged at, so tests
//! drive it with a fixed clock.

pub mod app_presence;
pub mod run_policy;
pub mod session_ledger;
pub mod session_plan;
pub mod unit_plan;
