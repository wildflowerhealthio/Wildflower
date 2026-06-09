pub mod authorization_code;
pub mod authorization_request;
pub mod client;
pub mod db;
pub mod grant;
pub mod local_client_token;
pub mod migrations;
pub mod signing_key;

pub use db::DbResult;

use std::path::Path;

use anyhow::Context;

use db::Connection;

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
        let mut conn = rusqlite::Connection::open_in_memory()
            .context("failed to open in-memory sqlite")?;
        migrations::migrate(&mut conn).context("failed to apply gatekeeper migrations")?;
        Ok(Self {
            conn: Connection::from_inner(conn),
        })
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }
}
