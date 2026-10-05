//! Pure relay tunnel domain — no diesel, axum, rusqlite or rathole coupling.
//!
//! [`TunnelSet`] is the live tunnels with their loopback ports, from the
//! environment and from the store. [`StoredTunnel`] is a tunnel created
//! through the admin API, and [`TunnelStore`] the persistence *port* that
//! keeps them (the `SQLite` adapter lives in [`crate::db`]). [`TunnelError`]
//! is the failure vocabulary the admin API renders. The [`actions`] decide a
//! create or delete against the live set and drive the store through the
//! port, so they run against an in-memory fake in tests. [`names`] draws the
//! default name of a tunnel created without one.

pub mod actions;
pub mod names;
mod stored_tunnel;
mod tunnel_error;
mod tunnel_set;
mod tunnel_store;
// The in-memory `FakeTunnelStore` the `actions` tests drive, plus the
// `stored_tunnel` builder the `db` tests seed from too. At the domain root
// (not under `actions`) since it's reused above that layer — the apps-rust
// `domain::test_fake` placement.
#[cfg(test)]
pub(crate) mod test_fake;

pub use stored_tunnel::StoredTunnel;
pub use tunnel_error::TunnelError;
pub use tunnel_set::{AddError, LiveTunnel, Source, TunnelSet};
pub use tunnel_store::TunnelStore;
