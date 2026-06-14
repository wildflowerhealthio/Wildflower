//! Gatekeeper's database layer. The generic, slice-agnostic SQLite primitives
//! live in the shared [`persistence_rust`] crate and are imported directly at
//! the use sites; this module owns only the gatekeeper-specific
//! [`GatekeeperStore`] (a wrapper over a shared connection) and migration list.
//! Per-table query methods live as `impl GatekeeperStore` blocks under
//! [`crate::db`].

pub mod gatekeeper_store;
pub mod migrations;

pub use gatekeeper_store::GatekeeperStore;
