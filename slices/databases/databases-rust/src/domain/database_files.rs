//! The [`DatabaseFiles`] port — the seam between the pure, scope-gated
//! [`capabilities`](crate::domain::capabilities) and the real filesystem/SQLite
//! side-effects. Keyed by [`DatabaseDescriptor`] so path resolution stays inside
//! the adapter (`crate::fs`'s `FilesystemDatabaseFiles`), never in the capability
//! — the capability holds an `Arc<dyn DatabaseFiles>` lifted from the state and
//! is stubbed with an in-memory fake in tests, so `domain/` is swappable and
//! runnable without a data directory.

use std::path::PathBuf;

use crate::config::DatabaseDescriptor;
use crate::domain::{DatabaseError, DatabaseMetadata};

/// The filesystem/SQLite operations the databases capabilities need, abstracted
/// behind a port so the capabilities depend on behaviour, not on `std::fs` /
/// `rusqlite` / a data directory. The production impl is
/// [`FilesystemDatabaseFiles`](crate::fs::FilesystemDatabaseFiles); tests supply
/// an in-memory fake.
pub(crate) trait DatabaseFiles: Send + Sync + 'static {
    /// Best-effort metadata for a catalogued database (a missing or unreadable
    /// file yields `exists: false`, never an error) — drives `GET /databases`.
    fn read_metadata(&self, descriptor: &DatabaseDescriptor) -> DatabaseMetadata;

    /// Snapshot the database to a fresh temp file the caller streams and unlinks;
    /// `Ok(None)` when the file is absent (→ `404`). `Ok(Some(path))` is a
    /// consistent `VACUUM INTO` copy.
    fn snapshot(&self, descriptor: &DatabaseDescriptor) -> Result<Option<PathBuf>, DatabaseError>;

    /// Schedule the database for deletion at next startup (drop a marker);
    /// `Ok(true)` when scheduled, `Ok(false)` when the file is absent (→ `404`).
    fn schedule_deletion(&self, descriptor: &DatabaseDescriptor) -> Result<bool, DatabaseError>;
}
