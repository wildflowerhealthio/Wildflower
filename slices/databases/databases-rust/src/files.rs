//! File-level operations on a database: a consistent export snapshot and an
//! on-disk delete. Both take an already-resolved path (the caller matched the
//! resource id against the catalogue first), so neither trusts client input.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Context;
use rusqlite::Connection;

/// How long the export connection waits on a lock held by the live writer
/// before giving up — generous enough to ride out the brief per-statement
/// locks the owning slice takes.
const EXPORT_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// Produce a consistent byte-for-byte snapshot of the database at `path`.
///
/// Uses `VACUUM INTO` rather than a raw file read: the source database has a
/// live writer (the slice that owns it), and a plain read could capture a torn
/// page mid-transaction. `VACUUM INTO` writes a fresh, internally-consistent
/// copy to a temporary sibling file, which we read and then remove.
///
/// # Errors
///
/// Returns an error if the source can't be opened, the snapshot can't be
/// written, or the temp file can't be read.
pub(crate) fn snapshot_database(path: &Path) -> anyhow::Result<Vec<u8>> {
    let conn =
        Connection::open(path).with_context(|| format!("open {} for export", path.display()))?;
    conn.busy_timeout(EXPORT_BUSY_TIMEOUT)
        .context("set export busy_timeout")?;

    let temp_path = unique_sibling(path, "export");
    // The temp path is an internally-generated sibling (process id + nanos), so
    // there is no untrusted input in this statement; escape quotes anyway as a
    // belt-and-braces measure.
    let escaped = temp_path.to_string_lossy().replace('\'', "''");
    conn.execute_batch(&format!("VACUUM INTO '{escaped}'"))
        .with_context(|| format!("VACUUM INTO snapshot of {}", path.display()))?;
    drop(conn);

    let bytes = std::fs::read(&temp_path)
        .with_context(|| format!("read export snapshot {}", temp_path.display()));
    // Always try to clean up the temp file, even if the read failed.
    let _ = std::fs::remove_file(&temp_path);
    bytes
}

/// Delete the database at `path` on disk, including any rollback-journal
/// sidecars. Persistence runs in rollback-journal mode (WAL is deliberately
/// off — see `persistence-rust`), so `-journal` is the only sidecar normally
/// present; `-wal` / `-shm` are removed defensively. A missing file is not an
/// error (the caller has already confirmed the main file exists).
///
/// # Errors
///
/// Returns an error if a present file can't be removed (e.g. a permission
/// problem). "Not found" is treated as success.
pub(crate) fn delete_database_files(path: &Path) -> std::io::Result<()> {
    remove_if_present(path)?;
    for suffix in ["-journal", "-wal", "-shm"] {
        remove_if_present(&sidecar(path, suffix))?;
    }
    Ok(())
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
