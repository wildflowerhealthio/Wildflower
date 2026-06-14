//! The shared `GatekeeperStore` handle: holds a synchronized rusqlite
//! connection and applies pending migrations at open time. Per-table query
//! methods are added as inherent `impl GatekeeperStore` blocks under
//! [`crate::db`].

use std::path::Path;

use anyhow::Context;

use crate::db_utils::migrations;
use persistence_rust::Connection;

#[derive(Clone)]
pub struct GatekeeperStore {
    conn: Connection,
}

impl GatekeeperStore {
    /// Open (or create) the sqlite database at `db_path` and apply pending
    /// migrations.
    ///
    /// # Errors
    ///
    /// Returns an error if the parent directory cannot be created, the sqlite
    /// file cannot be opened, or applying the gatekeeper migrations fails.
    pub fn open(db_path: &Path) -> anyhow::Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create db dir {}", parent.display()))?;
        }
        let conn = rusqlite::Connection::open(db_path)
            .with_context(|| format!("failed to open sqlite at {}", db_path.display()))?;
        Self::migrate_and_wrap(conn)
    }

    /// Open an in-memory sqlite database and apply pending migrations.
    ///
    /// # Errors
    ///
    /// Returns an error if the in-memory sqlite connection cannot be opened or
    /// applying the gatekeeper migrations fails.
    pub fn open_in_memory() -> anyhow::Result<Self> {
        let conn =
            rusqlite::Connection::open_in_memory().context("failed to open in-memory sqlite")?;
        Self::migrate_and_wrap(conn)
    }

    /// Apply pending migrations on a freshly-opened connection and wrap it
    /// in the shared `Connection` mutex. Shared tail of `open` /
    /// `open_in_memory`.
    fn migrate_and_wrap(mut conn: rusqlite::Connection) -> anyhow::Result<Self> {
        // Enforce declared foreign keys (e.g. refresh_tokens.family_id ->
        // refresh_token_families). SQLite defaults this OFF *per connection* and
        // rusqlite does not enable it, so the `REFERENCES` clauses were
        // previously decorative — an orphaned refresh token could be inserted
        // and would then read as "not found" instead of resolving to its
        // family. Set it before migrations and outside any transaction (the
        // pragma is a no-op inside one).
        conn.pragma_update(None, "foreign_keys", true)
            .context("failed to enable foreign_keys pragma")?;
        migrations::migrate(&mut conn).context("failed to apply gatekeeper migrations")?;
        Ok(Self {
            conn: Connection::from_inner(conn),
        })
    }

    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }
}
