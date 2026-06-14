//! The `GatekeeperStore` handle: wraps the *shared* sqlite connection (opened
//! once by the host and passed into each slice) and applies the gatekeeper
//! migrations onto it. Per-table query methods are added as inherent
//! `impl GatekeeperStore` blocks under [`crate::db`].

use anyhow::Context;
use persistence_rust::Connection;

use crate::db_utils::migrations;

#[derive(Clone)]
pub struct GatekeeperStore {
    conn: Connection,
}

impl GatekeeperStore {
    /// Wrap the shared `conn` and apply pending gatekeeper migrations onto it.
    /// The connection is opened once by the host (`persistence_rust::Connection`)
    /// and shared across slices; migrations are namespaced so they don't
    /// collide with another slice's tables.
    ///
    /// # Errors
    ///
    /// Returns an error if applying the gatekeeper migrations fails.
    pub fn new(conn: Connection) -> anyhow::Result<Self> {
        {
            let mut guard = conn.lock();
            migrations::migrate(&mut guard).context("failed to apply gatekeeper migrations")?;
        }
        Ok(Self { conn })
    }

    /// Open a private in-memory shared connection and wrap it — for tests.
    ///
    /// # Errors
    ///
    /// Returns an error if the in-memory connection can't be opened or migrated.
    pub fn open_in_memory() -> anyhow::Result<Self> {
        Self::new(Connection::open_in_memory().context("failed to open in-memory sqlite")?)
    }

    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }
}
