//! The [`TunnelStore`] **port** — the pure trait the domain depends on for
//! persistence. No diesel or rusqlite here: the port speaks only
//! [`StoredTunnel`]s. It signals a delete miss through `bool` and raises only
//! the opaque [`Infrastructure`](TunnelError::Infrastructure) failure; the
//! semantic outcomes (`Taken`, `NotFound`, …) are decided one layer up, in
//! the [`capabilities`](crate::domain::capabilities), against the live
//! [`TunnelSet`](crate::domain::TunnelSet), so both the `SQLite` adapter and
//! an in-memory test fake implement the same contract.
//!
//! The `SQLite` adapter lives in [`crate::db`] as `SqliteTunnelStore`; tests
//! substitute the in-memory `FakeTunnelStore` in `crate::domain::test_fake`.

use crate::domain::{StoredTunnel, TunnelError};

/// The persistence port for tunnels created through the admin API: the
/// primitive CRUD the domain needs over [`StoredTunnel`]s, raising the opaque
/// [`TunnelError::Infrastructure`]. The `SQLite` adapter
/// (`crate::db::SqliteTunnelStore`) implements it; unit tests swap in the
/// in-memory `FakeTunnelStore`.
pub trait TunnelStore {
    /// Every stored tunnel, by name.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / read failure.
    fn list_tunnels(&self) -> Result<Vec<StoredTunnel>, TunnelError>;

    /// Add `stored`.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / insert failure,
    /// including when the name is already stored (the primary key rejects it;
    /// the capabilities check the live set first, so a collision is a fault).
    fn insert_tunnel(&self, stored: &StoredTunnel) -> Result<(), TunnelError>;

    /// Remove the tunnel named `name`. Returns `true` when a row was removed,
    /// `false` on a miss.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / delete failure.
    fn delete_tunnel(&self, name: &str) -> Result<bool, TunnelError>;
}
