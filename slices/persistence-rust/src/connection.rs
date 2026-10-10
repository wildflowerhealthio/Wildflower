use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use parking_lot::{Mutex, MutexGuard};

pub type DbResult<T> = Result<T, rusqlite::Error>;

/// How long a statement waits for another connection to release its lock before
/// giving up with `SQLITE_BUSY` ("database is locked"). Generous enough to ride
/// out the brief per-query locks a DB browser or a second opener takes; a
/// connection that holds a transaction open indefinitely will still time out
/// (that's the case WAL would address — deliberately not enabled, so a surprise
/// shutdown leaves a plain rollback-journal db with nothing to recover).
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// Thin sync wrapper around a single `rusqlite::Connection`. Serializes access
/// through a mutex and is cheap to clone (an `Arc`), so the Tauri app can open
/// the database once and hand the same handle to every slice.
#[derive(Clone)]
pub struct Connection {
    conn: Arc<Mutex<rusqlite::Connection>>,
}

impl Connection {
    /// Open (or create) the shared sqlite database at `path`, creating the
    /// parent directory and enabling foreign keys. The Tauri app calls this
    /// once; each slice runs its own (namespaced) migrations on the result.
    ///
    /// # Errors
    ///
    /// Returns an error if the parent directory can't be created, the file
    /// can't be opened, or the `foreign_keys` pragma can't be set.
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create db dir {}", parent.display()))?;
        }
        let conn = rusqlite::Connection::open(path)
            .with_context(|| format!("failed to open sqlite at {}", path.display()))?;
        Self::configured(conn)
    }

    /// Open an in-memory shared database (tests).
    ///
    /// # Errors
    ///
    /// Returns an error if the connection can't be opened or configured.
    pub fn open_in_memory() -> anyhow::Result<Self> {
        let conn =
            rusqlite::Connection::open_in_memory().context("failed to open in-memory sqlite")?;
        Self::configured(conn)
    }

    /// Apply the per-connection runtime settings every opener needs, before
    /// wrapping:
    ///
    /// - `busy_timeout` so a write rides out brief contention from a second
    ///   connection instead of failing instantly with `SQLITE_BUSY` (see
    ///   [`BUSY_TIMEOUT`]).
    /// - `foreign_keys`, which `SQLite` defaults OFF per connection and rusqlite
    ///   doesn't enable. Set outside any transaction — the pragma is a no-op
    ///   inside one.
    fn configured(conn: rusqlite::Connection) -> anyhow::Result<Self> {
        conn.busy_timeout(BUSY_TIMEOUT)
            .context("failed to set busy_timeout")?;
        conn.pragma_update(None, "foreign_keys", true)
            .context("failed to enable foreign_keys pragma")?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn lock(&self) -> MutexGuard<'_, rusqlite::Connection> {
        self.conn.lock()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configures_the_busy_timeout() {
        let connection = Connection::open_in_memory().expect("open in-memory");
        let timeout_ms: i64 = connection
            .lock()
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .expect("read busy_timeout pragma");
        let expected = i64::try_from(BUSY_TIMEOUT.as_millis()).expect("timeout fits i64");
        assert_eq!(timeout_ms, expected);
    }
}
