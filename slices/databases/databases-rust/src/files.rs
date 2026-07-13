//! File-level operations on a database: a consistent export snapshot and a
//! cross-platform delete. Both take an already-resolved path (the caller matched
//! the resource id against the catalogue first), so neither trusts client input.
//!
//! ## Why deletion is scheduled, not immediate
//!
//! The owning slice holds a single long-lived `Connection` opened at startup, so
//! the database file is in use for the app's whole lifetime. Deleting it *now*
//! is unreliable cross-platform:
//!
//!  - On Windows the SQLite handle is opened without `FILE_SHARE_DELETE`, so
//!    `remove_file` fails with a sharing violation (an opaque 500).
//!  - On Unix the unlink succeeds but the open inode lives on, so the slice
//!    keeps reading/writing the now-anonymous file and a rollback-journal
//!    recovery can even recreate it at the original path.
//!
//! So [`schedule_deletion`] instead drops a marker file beside the database
//! (creating a *new* sibling is allowed even while the database is locked), and
//! the host calls [`purge_pending_deletions`] once at startup — before any
//! connection opens — to actually remove the file. The settings UI tells the
//! Owner to restart the app to finish.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

use crate::domain::DatabaseError;

/// How long the export connection waits on a lock held by the live writer
/// before giving up — generous enough to ride out the brief per-statement
/// locks the owning slice takes.
const EXPORT_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// Suffix of the "delete me at next startup" marker, appended to the database
/// filename (e.g. `health-data.sqlite.pending-delete`).
const MARKER_SUFFIX: &str = ".pending-delete";

/// Write a consistent byte-for-byte snapshot of the database at `path` to a
/// fresh temporary sibling file, returning its path. The caller streams the
/// temp file to the client and removes it afterwards.
///
/// Uses `VACUUM INTO` rather than a raw file read: the source database has a
/// live writer (the slice that owns it), and a plain read could capture a torn
/// page mid-transaction. `VACUUM INTO` writes a fresh, internally-consistent
/// copy. This is blocking work — run it on a blocking thread, not the async
/// runtime.
///
/// # Errors
///
/// [`DatabaseError::Infrastructure`] if the source can't be opened or the snapshot
/// can't be written — an opaque infrastructure failure the HTTP layer renders as
/// a logged 500.
pub(crate) fn snapshot_to_temp(path: &Path) -> Result<PathBuf, DatabaseError> {
    let conn = Connection::open(path)
        .map_err(|error| DatabaseError::infrastructure("open database for export", error))?;
    conn.busy_timeout(EXPORT_BUSY_TIMEOUT)
        .map_err(|error| DatabaseError::infrastructure("set export busy_timeout", error))?;

    let temp_path = unique_sibling(path, "export");
    // The temp path is an internally-generated sibling (process id + nanos), so
    // there is no untrusted input in this statement; escape quotes anyway as a
    // belt-and-braces measure.
    let escaped = temp_path.to_string_lossy().replace('\'', "''");
    conn.execute_batch(&format!("VACUUM INTO '{escaped}'"))
        .map_err(|error| DatabaseError::infrastructure("VACUUM INTO snapshot", error))?;
    Ok(temp_path)
}

/// Schedule the database at `path` for deletion at the next startup by writing
/// its marker file. Idempotent — a second call just rewrites the empty marker.
///
/// # Errors
///
/// [`DatabaseError::Infrastructure`] if the marker file can't be written — an opaque
/// infrastructure failure the HTTP layer renders as a logged 500.
pub(crate) fn schedule_deletion(path: &Path) -> Result<(), DatabaseError> {
    std::fs::write(marker_path(path), b"")
        .map_err(|error| DatabaseError::infrastructure("write pending-deletion marker", error))
}

/// Whether the database at `path` has a pending-deletion marker.
pub(crate) fn is_deletion_pending(path: &Path) -> bool {
    marker_path(path).exists()
}

/// Process every pending-deletion marker in `data_dir`: remove the database it
/// points at (plus journal sidecars) and then the marker. The host calls this
/// once at startup, *before* opening any database connection, so the files are
/// not in use and the removal succeeds on every platform. A missing `data_dir`
/// (fresh install) is a no-op.
///
/// # Errors
///
/// Returns an error if the directory can't be read or a present file can't be
/// removed.
pub fn purge_pending_deletions(data_dir: &Path) -> std::io::Result<()> {
    let entries = match std::fs::read_dir(data_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = entry?;
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        let Some(db_name) = name.strip_suffix(MARKER_SUFFIX) else {
            continue;
        };
        delete_database_files(&data_dir.join(db_name))?;
        remove_if_present(&entry.path())?;
    }
    Ok(())
}

/// Delete the database at `path` on disk, including any rollback-journal
/// sidecars. Persistence runs in rollback-journal mode (WAL is deliberately
/// off — see `persistence-rust`), so `-journal` is the only sidecar normally
/// present; `-wal` / `-shm` are removed defensively. A missing file is not an
/// error.
fn delete_database_files(path: &Path) -> std::io::Result<()> {
    remove_if_present(path)?;
    for suffix in ["-journal", "-wal", "-shm"] {
        remove_if_present(&sidecar(path, suffix))?;
    }
    Ok(())
}

/// The pending-deletion marker path for a database file.
fn marker_path(path: &Path) -> PathBuf {
    sidecar(path, MARKER_SUFFIX)
}

/// `path` with `suffix` appended to the filename, e.g.
/// `health-data.sqlite` + `-journal` → `health-data.sqlite-journal`.
fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Remove a file, treating "already gone" as success.
fn remove_if_present(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// A unique sibling path of `path` tagged with `tag`, the process id, and a
/// nanosecond timestamp — so concurrent exports can't collide on the temp file
/// `VACUUM INTO` writes (it refuses to overwrite an existing target).
fn unique_sibling(path: &Path, tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    path.with_extension(format!("{tag}-{}-{nanos}.tmp", std::process::id()))
}
