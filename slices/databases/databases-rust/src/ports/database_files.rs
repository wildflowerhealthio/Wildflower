//! The [`DatabaseFiles`] port — the seam between the pure, scope-gated
//! [`capabilities`](crate::domain::capabilities) and the real filesystem/SQLite
//! side-effects. Keyed by [`DatabaseDescriptor`] so path resolution stays inside
//! the adapter ([`crate::adapters`]'s `FilesystemDatabaseFiles`), never in the capability
//! — the capability is generic over the port and holds it by value (the concrete
//! adapter binds once in [`crate::live_bindings`]), and is stubbed with an
//! in-memory fake in tests, so `domain/` is swappable and
//! runnable without a data directory.

use std::path::PathBuf;
use std::sync::Arc;

use crate::config::DatabaseDescriptor;
use crate::domain::{DatabaseError, DatabaseMetadata};

/// The filesystem/SQLite operations the databases capabilities need, abstracted
/// behind a port so the capabilities depend on behaviour, not on `std::fs` /
/// `rusqlite` / a data directory. The production impl is
/// [`FilesystemDatabaseFiles`](crate::adapters::FilesystemDatabaseFiles); tests
/// supply an in-memory fake.
///
/// `#[async_trait]` because [`read_catalogue_metadata`](Self::read_catalogue_metadata)
/// is `async` behind an `Arc<dyn …>`, which a native `async fn` can't be
/// dyn-compatibly.
#[async_trait::async_trait]
pub(crate) trait DatabaseFiles: Send + Sync + 'static {
    /// Best-effort metadata for every catalogued database (a missing or
    /// unreadable file yields `exists: false`, never an error) — drives
    /// `GET /databases`. Owns dispatching the per-file blocking reads off the
    /// async runtime, so the capability just `.await`s the whole listing.
    async fn read_catalogue_metadata(
        &self,
        catalogue: Arc<[DatabaseDescriptor]>,
    ) -> Result<Vec<DatabaseMetadata>, DatabaseError>;

    /// Snapshot the database to a fresh temp file the caller streams and unlinks
    /// — a consistent `VACUUM INTO` copy. An absent-but-catalogued database is
    /// [`NotFound`](DatabaseError::NotFound) (→ `404`). Owns dispatching the
    /// blocking `VACUUM`/IO off the async runtime.
    async fn temp_download_for_descriptor(
        &self,
        descriptor: DatabaseDescriptor,
    ) -> Result<PathBuf, DatabaseError>;

    /// Schedule the database for deletion at next startup (drop a marker). An
    /// absent-but-catalogued database is [`NotFound`](DatabaseError::NotFound)
    /// (→ `404`). Owns dispatching the blocking marker write off the async
    /// runtime.
    async fn schedule_delete(&self, descriptor: DatabaseDescriptor) -> Result<(), DatabaseError>;
}
