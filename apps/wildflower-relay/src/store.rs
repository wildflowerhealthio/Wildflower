//! The tunnels created through the admin API, kept in SQLite at
//! `<WILDFLOWER_RELAY_STATE_DIR>/tunnels.db`.
//!
//! Each row is a tunnel's name, the email of whoever it belongs to, its
//! token and when it was created. Tokens are stored in plain text, since
//! rathole and the HMAC check both need them, so the file is created
//! readable by the owner only, like the rendered rathole TOML. The schema
//! comes from the append-only migrations in `src/migrations`, applied on
//! every open under the `wildflower_relay` namespace (see
//! [`persistence_rust::run_migrations`]).

use std::path::Path;

use anyhow::Context;
use persistence_rust::Connection;
use rusqlite::params;

use crate::settings::{Secret, Tunnel};

/// Migration namespace for the relay's tables.
const NAMESPACE: &str = "wildflower_relay";

/// Ordered, append-only schema migrations. The array index is the recorded
/// `schema_migrations` version: never reorder or rewrite a shipped entry.
const MIGRATIONS: &[&str] = &[include_str!("migrations/001_tunnels.sql")];

/// One stored tunnel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredTunnel {
    pub tunnel: Tunnel,
    /// Who the tunnel belongs to.
    pub email: String,
    /// Unix epoch seconds.
    pub created_at: i64,
}

/// The SQLite store of tunnels created through the admin API.
#[derive(Clone)]
pub struct TunnelStore {
    conn: Connection,
}

impl std::fmt::Debug for TunnelStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TunnelStore").finish_non_exhaustive()
    }
}

impl TunnelStore {
    /// The store's file name in the state directory.
    pub const FILE_NAME: &'static str = "tunnels.db";

    /// Open (or create) the store at `path`, readable by the owner only, and
    /// apply its migrations.
    ///
    /// # Errors
    ///
    /// Returns an error if the file cannot be created or opened, or a
    /// migration fails.
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        create_private(path).with_context(|| format!("creating {}", path.display()))?;
        Self::migrated(Connection::open(path)?)
            .with_context(|| format!("migrating {}", path.display()))
    }

    /// An empty store in memory, for tests.
    ///
    /// # Errors
    ///
    /// Returns an error if the connection cannot be opened or migrated.
    pub fn open_in_memory() -> anyhow::Result<Self> {
        Self::migrated(Connection::open_in_memory()?)
    }

    fn migrated(conn: Connection) -> anyhow::Result<Self> {
        persistence_rust::run_migrations(&mut conn.lock(), NAMESPACE, MIGRATIONS)?;
        Ok(Self { conn })
    }

    /// Every stored tunnel, by name.
    ///
    /// # Errors
    ///
    /// Returns an error if the query fails.
    pub fn list(&self) -> anyhow::Result<Vec<StoredTunnel>> {
        let conn = self.conn.lock();
        let mut statement =
            conn.prepare("SELECT name, email, token, created_at FROM tunnels ORDER BY name")?;
        let tunnels = statement
            .query_map([], |row| {
                Ok(StoredTunnel {
                    tunnel: Tunnel {
                        name: row.get(0)?,
                        token: Secret::new(row.get::<_, String>(2)?),
                    },
                    email: row.get(1)?,
                    created_at: row.get(3)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(tunnels)
    }

    /// Add `stored`.
    ///
    /// # Errors
    ///
    /// Returns an error if the insert fails, e.g. because the name is
    /// already stored.
    pub fn insert(&self, stored: &StoredTunnel) -> anyhow::Result<()> {
        self.conn.lock().execute(
            "INSERT INTO tunnels (name, email, token, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![
                stored.tunnel.name,
                stored.email,
                stored.tunnel.token.expose(),
                stored.created_at
            ],
        )?;
        Ok(())
    }

    /// Remove the tunnel named `name`; `false` if there was none.
    ///
    /// # Errors
    ///
    /// Returns an error if the delete fails.
    pub fn delete(&self, name: &str) -> anyhow::Result<bool> {
        let deleted = self
            .conn
            .lock()
            .execute("DELETE FROM tunnels WHERE name = ?1", [name])?;
        Ok(deleted > 0)
    }
}

/// Create `path` if it is missing, readable by the owner only. SQLite gives
/// its journal the same mode.
fn create_private(path: &Path) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(false);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path).map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored(name: &str) -> StoredTunnel {
        StoredTunnel {
            tunnel: Tunnel {
                name: name.to_owned(),
                token: Secret::new(format!("{name}-token")),
            },
            email: format!("{name}@example.com"),
            created_at: 1_700_000_000,
        }
    }

    #[test]
    fn inserts_lists_by_name_and_deletes() {
        let store = TunnelStore::open_in_memory().unwrap();
        store.insert(&stored("bob")).unwrap();
        store.insert(&stored("alice")).unwrap();
        assert_eq!(store.list().unwrap(), [stored("alice"), stored("bob")]);
        assert!(store.insert(&stored("alice")).is_err(), "names are unique");

        assert!(store.delete("alice").unwrap());
        assert!(!store.delete("alice").unwrap());
        assert_eq!(store.list().unwrap(), [stored("bob")]);
    }

    #[test]
    fn the_file_is_private_and_persists_across_opens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(TunnelStore::FILE_NAME);
        TunnelStore::open(&path)
            .unwrap()
            .insert(&stored("alice"))
            .unwrap();
        assert_eq!(
            TunnelStore::open(&path).unwrap().list().unwrap(),
            [stored("alice")]
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}
