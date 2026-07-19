//! The [`RemotesStore`] **port** — the pure trait the domain depends on for
//! persistence. No diesel or axum here: the port speaks primitive CRUD over the
//! domain [`Remote`] type, signalling absence/conflict through return types
//! (`Option` / `bool`) rather than semantic errors, and raising only the opaque
//! [`Infrastructure`](RemoteError::Infrastructure) failure. The semantic
//! outcomes (`NotFound`, `AlreadyExists`) are decided one layer up, in
//! [`crate::domain::capabilities`], so both the `SQLite` adapter and an in-memory
//! test fake implement the same primitive contract.
//!
//! The `SQLite` adapter lives in [`crate::db`] as `SqliteRemotesStore`; tests
//! substitute the in-memory `FakeRemotesStore` in
//! [`crate::domain::capabilities`].

use crate::domain::{Remote, RemoteError};

/// The persistence port for collector remotes: the primitive CRUD the domain
/// needs, over the domain [`Remote`], raising only the opaque [`RemoteError`].
/// Absence and conflict are return-type signals (`get`/`update` return `None`
/// when the id is absent; `insert`/`delete` return `false` when they affect no
/// row), NOT semantic errors — [`crate::domain::capabilities`] map those signals
/// onto `NotFound` / `AlreadyExists`. The `SQLite` adapter
/// (`crate::db::SqliteRemotesStore`) implements it; unit tests swap in the
/// in-memory `FakeRemotesStore`.
pub trait RemotesStore {
    /// Every remote, oldest first (ties broken by id so the order is total).
    ///
    /// # Errors
    ///
    /// [`RemoteError::Infrastructure`] on a checkout / read failure or a corrupt
    /// stored config.
    fn list(&self) -> Result<Vec<Remote>, RemoteError>;

    /// A single remote by id, or `None` when no remote has this id.
    ///
    /// # Errors
    ///
    /// [`RemoteError::Infrastructure`] on a checkout / read failure or a corrupt
    /// stored config.
    fn get(&self, id: &str) -> Result<Option<Remote>, RemoteError>;

    /// Insert a fresh remote. Returns `true` when the row was written, `false`
    /// when the id was already taken (the insert affected 0 rows) — a conflict
    /// rather than a silent overwrite.
    ///
    /// # Errors
    ///
    /// [`RemoteError::Infrastructure`] on a checkout / insert failure.
    fn insert(&self, remote: &Remote) -> Result<bool, RemoteError>;

    /// Update an existing remote's `name` / `tag` / `config` (id and `added_at`
    /// are immutable) and return the resulting row, or `None` when no remote has
    /// this id.
    ///
    /// # Errors
    ///
    /// [`RemoteError::Infrastructure`] on a checkout / update failure or a
    /// corrupt stored config.
    fn update(
        &self,
        id: &str,
        name: &str,
        tag: &str,
        config: &serde_json::Value,
    ) -> Result<Option<Remote>, RemoteError>;

    /// Remove a remote by id. Returns `true` when a row was removed, `false`
    /// when no remote had this id.
    ///
    /// # Errors
    ///
    /// [`RemoteError::Infrastructure`] on a checkout / delete failure.
    fn delete(&self, id: &str) -> Result<bool, RemoteError>;
}
