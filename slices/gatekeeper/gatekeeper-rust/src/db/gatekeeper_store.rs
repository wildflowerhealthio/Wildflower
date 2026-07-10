//! The `GatekeeperStore` handle — wraps the shared connection and applies the
//! gatekeeper schema migrations onto it. Per-table query methods are added as
//! inherent `impl GatekeeperStore` blocks in the sibling `db/*` modules.

use anyhow::Context;
use persistence_rust::Connection;

#[derive(Clone)]
pub struct GatekeeperStore {
    conn: Connection,
}

impl GatekeeperStore {
    /// Wrap the shared `conn` and apply pending gatekeeper migrations onto it.
    /// The connection is opened once by the host and shared across slices;
    /// migrations are namespaced so they don't collide with another slice's.
    ///
    /// # Errors
    ///
    /// Returns an error if applying the gatekeeper migrations fails.
    pub fn new(conn: Connection) -> anyhow::Result<Self> {
        {
            let mut guard = conn.lock();
            migrate(&mut guard).context("failed to apply gatekeeper migrations")?;
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

/// Migration namespace for the gatekeeper tables in the shared database.
const NAMESPACE: &str = "gatekeeper";

/// Apply pending gatekeeper migrations through the shared
/// [`persistence_rust::run_migrations`] runner under the `gatekeeper` namespace.
fn migrate(conn: &mut rusqlite::Connection) -> rusqlite::Result<()> {
    persistence_rust::run_migrations(conn, NAMESPACE, MIGRATIONS)
}

/// Ordered list of schema migrations. The array index is the recorded
/// `schema_migrations` version — append-only; never reorder or rewrite an
/// already-shipped entry. New migrations land as a sibling `.sql` file under
/// `src/migrations/` plus one new `include_str!` line below.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/001_initial_schema.sql"),
    include_str!("../migrations/002_refresh_tokens.sql"),
    include_str!("../migrations/003_refresh_family_authorization_code.sql"),
    include_str!("../migrations/004_unique_authorization_code_request_id.sql"),
    include_str!("../migrations/005_unique_pending_user_code.sql"),
    include_str!("../migrations/006_unique_grant_client_redirect.sql"),
    include_str!("../migrations/007_client_allowed_grant_types.sql"),
    include_str!("../migrations/008_seed_sample_clients.sql"),
    include_str!("../migrations/009_authorization_request_device_name.sql"),
    include_str!("../migrations/010_polymorphic_grants.sql"),
    include_str!("../migrations/011_refresh_family_grant_id.sql"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_is_idempotent() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();
        let v: i64 = conn
            .query_row(
                "SELECT version FROM schema_migrations WHERE namespace = ?1",
                [NAMESPACE],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(v as usize, MIGRATIONS.len());
    }

    #[test]
    fn migrate_creates_expected_tables() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        let names: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for expected in [
            "authorization_codes",
            "authorization_code_grants",
            "authorization_requests",
            "clients",
            "device_grants",
            "grants",
            "refresh_token_families",
            "refresh_tokens",
            "signing_keys",
        ] {
            assert!(names.iter().any(|n| n == expected), "missing {expected}");
        }
    }

    /// Migration 010 splits the flat `grants` table into a parent + per-variant
    /// children. A row that existed before the split must land intact as an
    /// `authorization_code` parent with its `redirect_uri` moved into the
    /// authorization-code child. Applying migrations 001..=009 first, seeding a
    /// legacy flat row, then applying the rest exercises the data migration —
    /// `open_in_memory` would apply everything at once and skip the copy.
    #[test]
    fn migration_010_moves_existing_grants_into_parent_and_child() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();

        // The pre-polymorphic schema (through migration 009).
        persistence_rust::run_migrations(&mut conn, NAMESPACE, &MIGRATIONS[..9]).unwrap();
        conn.execute(
            "INSERT INTO grants (id, client_id, scopes, redirect_uri, granted_at, last_used_at, patient) \
             VALUES ('g1', 'client-a', '[\"read\"]', 'https://example.com/cb', \
                     '2024-01-01T00:00:00Z', NULL, 'patient-1')",
            [],
        )
        .unwrap();

        // Apply the polymorphic split (migration 010) and the rest.
        persistence_rust::run_migrations(&mut conn, NAMESPACE, MIGRATIONS).unwrap();

        // The parent keeps the shared fields and gains `grant_type`; the flat
        // `redirect_uri` column is gone.
        let (client_id, grant_type, patient): (String, String, Option<String>) = conn
            .query_row(
                "SELECT client_id, grant_type, patient FROM grants WHERE id = 'g1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(client_id, "client-a");
        assert_eq!(grant_type, "authorization_code");
        assert_eq!(patient.as_deref(), Some("patient-1"));

        let parent_has_redirect: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('grants') WHERE name = 'redirect_uri'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(parent_has_redirect, 0, "parent must drop redirect_uri");

        // The redirect_uri moved into the authorization-code child, denormalized
        // client_id alongside it.
        let (child_client_id, redirect_uri): (String, String) = conn
            .query_row(
                "SELECT client_id, redirect_uri FROM authorization_code_grants WHERE id = 'g1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(child_client_id, "client-a");
        assert_eq!(redirect_uri, "https://example.com/cb");
    }
}
