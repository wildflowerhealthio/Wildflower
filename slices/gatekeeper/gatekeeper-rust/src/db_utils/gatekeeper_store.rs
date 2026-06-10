//! The shared `GatekeeperStore` handle: holds a synchronized rusqlite
//! connection and applies pending migrations at open time. Per-table query
//! methods are added as inherent `impl GatekeeperStore` blocks under
//! [`crate::db`].

use std::path::Path;

use anyhow::Context;

use crate::db_utils::connection::Connection;
use crate::db_utils::migrations;

#[derive(Clone)]
pub struct GatekeeperStore {
    conn: Connection,
}

impl GatekeeperStore {
    pub fn open(db_path: &Path) -> anyhow::Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create db dir {:?}", parent))?;
        }
        let conn = rusqlite::Connection::open(db_path)
            .with_context(|| format!("failed to open sqlite at {:?}", db_path))?;
        Self::migrate_and_wrap(conn)
    }

    pub fn open_in_memory() -> anyhow::Result<Self> {
        let conn =
            rusqlite::Connection::open_in_memory().context("failed to open in-memory sqlite")?;
        Self::migrate_and_wrap(conn)
    }

    /// Apply pending migrations on a freshly-opened connection and wrap it
    /// in the shared `Connection` mutex. Shared tail of `open` /
    /// `open_in_memory`.
    fn migrate_and_wrap(mut conn: rusqlite::Connection) -> anyhow::Result<Self> {
        migrations::migrate(&mut conn).context("failed to apply gatekeeper migrations")?;
        Ok(Self {
            conn: Connection::from_inner(conn),
        })
    }

    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }
}
