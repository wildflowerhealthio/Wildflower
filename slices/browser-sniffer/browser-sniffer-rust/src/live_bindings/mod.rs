//! The `FixedScopeCapability` bindings — where the generic capabilities in
//! [`crate::domain::capabilities`] meet the concrete host handle / event
//! stream and the `Arc<SnifferState>` router state. Each binding lifts what it
//! needs out of the state (never the whole state), so `domain/` stays free of
//! `crate::http`. The `Claims` type is the ready-made
//! [`ScopeClaims`](scope_capabilities_rust::ScopeClaims) the host's bearer
//! gate inserts. Mirrors `collector-rust`'s layout.

mod sniffer_driver;
mod sniffer_observer;
pub mod state;
