//! Gatekeeper's schema migration list, applied through the shared
//! [`persistence_rust::run_migrations`] `PRAGMA user_version` runner (the
//! generic runner lifted out of this module). The list is append-only; the
//! runner applies each pending entry once, in order.

use rusqlite::Connection;

/// Apply pending gatekeeper migrations.
///
/// # Errors
///
/// Returns any rusqlite error surfaced by [`persistence_rust::run_migrations`].
pub fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    persistence_rust::run_migrations(conn, MIGRATIONS)
}

/// Ordered list of schema migrations. The array index is the persisted
/// `PRAGMA user_version` — append-only; never reorder or rewrite an
/// already-shipped entry. New migrations land as a sibling `.sql` file
/// under `src/migrations/` plus one new `include_str!` line below.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/001_initial_schema.sql"),
    include_str!("../migrations/002_refresh_tokens.sql"),
    include_str!("../migrations/003_refresh_family_authorization_code.sql"),
    include_str!("../migrations/004_unique_authorization_code_request_id.sql"),
    include_str!("../migrations/005_unique_pending_user_code.sql"),
    include_str!("../migrations/006_unique_grant_client_redirect.sql"),
    include_str!("../migrations/007_client_allowed_grant_types.sql"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_is_idempotent() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();
        let v: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(v as usize, MIGRATIONS.len());
    }

    #[test]
    fn migrate_creates_expected_tables() {
        let mut conn = Connection::open_in_memory().unwrap();
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
            "authorization_requests",
            "clients",
            "grants",
            "refresh_token_families",
            "refresh_tokens",
            "signing_keys",
        ] {
            assert!(names.iter().any(|n| n == expected), "missing {expected}");
        }
    }
}
