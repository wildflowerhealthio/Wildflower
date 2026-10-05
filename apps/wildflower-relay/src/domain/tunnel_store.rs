//! The [`TunnelStore`] **port** — the pure trait the domain depends on for
//! persistence. No diesel or rusqlite here: the port speaks only
//! [`StoredTunnel`]s. It signals a name already stored, or not stored, through
//! its return values and raises only the opaque
//! [`Infrastructure`](TunnelError::Infrastructure) failure; the semantic
//! outcomes (`Taken`, `NotFound`, …) are decided one layer up, in the
//! [`capabilities`](crate::domain::capabilities), so both the `SQLite`
//! adapter and an in-memory test fake implement the same contract.
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

    /// Whether a tunnel named `name` is stored.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / read failure.
    fn contains_tunnel(&self, name: &str) -> Result<bool, TunnelError>;

    /// Add `stored`. Returns `true` when it was added, `false`, storing
    /// nothing, when a tunnel of that name is already stored.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / insert failure.
    fn insert_tunnel(&self, stored: &StoredTunnel) -> Result<bool, TunnelError>;

    /// Remove the tunnel named `name`. Returns what was stored, or `None` on
    /// a miss.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / delete failure.
    fn delete_tunnel(&self, name: &str) -> Result<Option<StoredTunnel>, TunnelError>;
}
