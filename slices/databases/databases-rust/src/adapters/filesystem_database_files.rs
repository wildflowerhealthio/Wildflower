//! The filesystem adapter for the [`DatabaseFiles`](crate::ports::DatabaseFiles)
//! port — the concrete `std::fs` / `rusqlite` side of the databases slice. It
//! resolves a catalogued [`DatabaseDescriptor`] to its path beneath the host's
//! data directory and performs the metadata read, the `VACUUM INTO` export
//! snapshot, and the pending-deletion marker write. The file-level primitives
//! live in [`crate::files`]; this module keys them by descriptor and reads the
//! metadata that populates [`DatabaseMetadata`].
//!
//! It lives outside `domain/` deliberately: the capabilities depend on the
//! `DatabaseFiles` port, and `crate::setup_databases` injects one of these — so
//! `domain/` never touches the filesystem and stays stubbable.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::OpenFlags;

use crate::config::DatabaseDescriptor;
use crate::domain::{DatabaseError, DatabaseMetadata};
use crate::ports::DatabaseFiles;

/// The production [`DatabaseFiles`]: resolves each catalogued id to
/// `data_dir.join(id)` and delegates to the [`crate::files`] primitives. Built
/// once by [`crate::setup_databases`], held by the `DatabasesState`, and cloned
/// by value into each capability at construction (cheap — it only wraps the
/// data-dir path).
#[derive(Clone)]
pub(crate) struct FilesystemDatabaseFiles {
    data_dir: PathBuf,
}

impl FilesystemDatabaseFiles {
    /// Build the adapter over the host's app-data directory. Every resource id
    /// resolves to `data_dir.join(id)`.
    pub(crate) fn new(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }

    /// The on-disk path for a catalogued database — built from the host-supplied
    /// catalogue filename, never from raw client input.
    fn path_for(&self, descriptor: &DatabaseDescriptor) -> PathBuf {
        self.data_dir.join(&descriptor.id)
    }
}

#[async_trait::async_trait]
impl DatabaseFiles for FilesystemDatabaseFiles {
    async fn read_catalogue_metadata(
        &self,
        catalogue: Arc<[DatabaseDescriptor]>,
    ) -> Result<Vec<DatabaseMetadata>, DatabaseError> {
        // Resolve every path up front (cheap, sync) so `path_for` stays the one
        // place ids become filesystem paths; the blocking closure then owns only
        // the descriptor+path pairs it reads.
        let jobs: Vec<(DatabaseDescriptor, PathBuf)> = catalogue
            .iter()
            .map(|descriptor| (descriptor.clone(), self.path_for(descriptor)))
            .collect();
        // The per-database reads are best-effort and blocking, so the loop runs
        // on a blocking thread rather than stalling the async runtime.
        tokio::task::spawn_blocking(move || {
            jobs.iter()
                .map(|(descriptor, path)| read_metadata(descriptor, path))
                .collect()
        })
        .await
        .map_err(|error| DatabaseError::infrastructure("list metadata task panicked", error))
    }

    async fn temp_download_for_descriptor(
        &self,
        descriptor: DatabaseDescriptor,
    ) -> Result<PathBuf, DatabaseError> {
        let path = self.path_for(&descriptor);
        tokio::task::spawn_blocking(move || {
            // Prove existence before the (blocking) snapshot, so an
            // absent-but-catalogued database is a `404` rather than an opaque
            // open failure.
            if path.exists() {
                crate::files::snapshot_to_temp(&path).map(Some)
            } else {
                Ok(None)
            }
        })
        .await
        .map_err(|error| DatabaseError::infrastructure("snapshot task panicked", error))??
        .ok_or(DatabaseError::NotFound { id: descriptor.id })
    }

    async fn schedule_delete(&self, descriptor: DatabaseDescriptor) -> Result<(), DatabaseError> {
        let path = self.path_for(&descriptor);
        let scheduled = tokio::task::spawn_blocking(move || {
            if path.exists() {
                crate::files::schedule_deletion(&path).map(|()| true)
            } else {
                Ok(false)
            }
        })
        .await
        .map_err(|error| DatabaseError::infrastructure("delete task panicked", error))??;
        if scheduled {
            Ok(())
        } else {
            Err(DatabaseError::NotFound { id: descriptor.id })
        }
    }
}

/// Read the metadata for `descriptor` at `path`. Never fails: a missing or
/// unreadable file yields `exists: false` with zeroed/absent fields.
fn read_metadata(descriptor: &DatabaseDescriptor, path: &Path) -> DatabaseMetadata {
    let file_metadata = std::fs::metadata(path).ok();
    let exists = file_metadata.is_some();
    let size_bytes = file_metadata.as_ref().map_or(0, std::fs::Metadata::len);
    let modified_at = file_metadata
        .as_ref()
        .and_then(|m| m.modified().ok())
        .map(|time| DateTime::<Utc>::from(time).to_rfc3339_opts(SecondsFormat::Millis, true));
    let table_count = if exists {
        count_user_tables(path)
    } else {
        None
    };

    DatabaseMetadata {
        id: descriptor.id.clone(),
        label: descriptor.label.clone(),
        description: descriptor.description.clone(),
        exists,
        size_bytes,
        table_count,
        modified_at,
        pending_deletion: crate::files::is_deletion_pending(path),
    }
}

/// Count the user tables (excluding SQLite's own `sqlite_*` bookkeeping) via a
/// throwaway read-only connection. Best-effort: any open/query failure (a
/// locked, corrupt, or non-SQLite file) collapses to `None` rather than failing
/// the whole listing.
fn count_user_tables(path: &Path) -> Option<u64> {
    let conn =
        rusqlite::Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get(0),
        )
        .ok()?;
    u64::try_from(count).ok()
}
