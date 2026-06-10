//! SQLite persistence for the gatekeeper. All rusqlite knowledge lives
//! under this module: the connection wrapper, schema migrations, and one
//! file per table holding the row mappings and `GatekeeperStore` query
//! methods for that table's [`crate::domain`] type.

mod authorization_codes;
mod authorization_requests;
mod clients;
mod connection;
mod grants;
mod local_client_token;
mod migrations;
mod signing_keys;

pub use connection::DbResult;

use std::path::Path;

use anyhow::Context;

use connection::Connection;

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
        let mut conn = rusqlite::Connection::open(db_path)
            .with_context(|| format!("failed to open sqlite at {:?}", db_path))?;
        migrations::migrate(&mut conn).context("failed to apply gatekeeper migrations")?;
        Ok(Self {
            conn: Connection::from_inner(conn),
        })
    }

    pub fn open_in_memory() -> anyhow::Result<Self> {
        let mut conn =
            rusqlite::Connection::open_in_memory().context("failed to open in-memory sqlite")?;
        migrations::migrate(&mut conn).context("failed to apply gatekeeper migrations")?;
        Ok(Self {
            conn: Connection::from_inner(conn),
        })
    }

    pub(in crate::db) fn conn(&self) -> &Connection {
        &self.conn
    }
}
