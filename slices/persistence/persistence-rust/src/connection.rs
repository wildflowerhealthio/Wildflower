use std::path::Path;
use std::sync::Arc;

use anyhow::Context;
use parking_lot::{Mutex, MutexGuard};

pub type DbResult<T> = Result<T, rusqlite::Error>;

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

    /// Enforce declared foreign keys (SQLite defaults this OFF per connection,
    /// and rusqlite doesn't enable it) before wrapping. Set outside any
    /// transaction — the pragma is a no-op inside one.
    fn configured(conn: rusqlite::Connection) -> anyhow::Result<Self> {
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
