//! The apps-slice schema migrations and the runner that applies them under the
//! `apps` namespace of the shared database.

/// Migration namespace for the apps tables in the shared database.
const NAMESPACE: &str = "apps";

/// Apply pending apps migrations through the shared
/// [`persistence_rust::run_migrations`] runner under the `apps` namespace, so
/// they coexist with other slices in one shared database.
pub(super) fn migrate(conn: &mut rusqlite::Connection) -> rusqlite::Result<()> {
    persistence_rust::run_migrations(conn, NAMESPACE, MIGRATIONS)
}

/// Ordered list of schema migrations. The array index is the recorded
/// `schema_migrations` version — append-only; never reorder or rewrite an
/// already-shipped entry. `004` introduces the parent registry + per-kind child
/// tables and seeds the default set; `005` / `006` add the `seeded` flag and the
/// nullable `launch_path`. Each runs once per database, so a user-deleted seeded
/// row stays deleted across upgrades — only fresh installs see the full set.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/001_initial_schema.sql"),
    include_str!("../migrations/002_internal_apps_table.sql"),
    include_str!("../migrations/003_seed_precise_hbr.sql"),
    include_str!("../migrations/004_apps_registry.sql"),
    include_str!("../migrations/005_self_hosted_seeded.sql"),
    include_str!("../migrations/006_self_hosted_launch_path.sql"),
];

#[cfg(test)]
mod tests {
    use rusqlite::params;

    use super::*;

    #[test]
    fn migrate_is_idempotent_and_creates_the_registry_tables() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();
        for table in ["apps", "cloud_apps", "self_hosted_apps"] {
            let exists: bool = conn
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
                    params![table],
                    |_| Ok(true),
                )
                .unwrap_or(false);
            assert!(exists, "{table} table must exist after migrate");
        }
    }
}
