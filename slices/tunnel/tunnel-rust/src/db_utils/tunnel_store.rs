//! The `TunnelStore` handle: wraps the *shared* sqlite connection (opened once
//! by the host and passed into each slice) and applies the tunnel migrations
//! onto it. Per-table query methods are added as inherent `impl TunnelStore`
//! blocks under [`crate::db`]. Mirrors `gatekeeper-rust`'s `GatekeeperStore`.

use anyhow::Context;
use persistence_rust::Connection;

use crate::db_utils::migrations;

#[derive(Clone)]
pub struct TunnelStore {
    conn: Connection,
}

impl TunnelStore {
    /// Wrap the shared `conn` and apply pending tunnel migrations onto it. The
    /// connection is opened once by the host and shared across slices;
    /// migrations are namespaced so they don't collide with another slice's.
    ///
    /// # Errors
    ///
    /// Returns an error if applying the tunnel migrations fails.
    pub fn new(conn: Connection) -> anyhow::Result<Self> {
        {
            let mut guard = conn.lock();
            migrations::migrate(&mut guard).context("failed to apply tunnel migrations")?;
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
