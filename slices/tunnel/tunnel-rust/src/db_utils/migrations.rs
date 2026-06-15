//! The tunnel slice's schema migration list, applied through the shared
//! [`persistence_rust::run_migrations`] runner under the `tunnel` namespace, so
//! it coexists with other slices in one shared database. Append-only.

use rusqlite::Connection;

/// Migration namespace for the tunnel tables in the shared database.
const NAMESPACE: &str = "tunnel";

/// Apply pending tunnel migrations.
///
/// # Errors
///
/// Returns any rusqlite error surfaced by [`persistence_rust::run_migrations`].
pub fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    persistence_rust::run_migrations(conn, NAMESPACE, MIGRATIONS)
}

/// Ordered, append-only schema migrations. The array index is the recorded
/// `schema_migrations` version; never reorder or rewrite a shipped entry.
const MIGRATIONS: &[&str] = &[include_str!("../migrations/001_initial_schema.sql")];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_is_idempotent_and_creates_the_settings_table() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='tunnel_settings'",
                [],
                |_| Ok(true),
            )
            .unwrap_or(false);
        assert!(exists, "tunnel_settings table must exist after migrate");
    }
}
