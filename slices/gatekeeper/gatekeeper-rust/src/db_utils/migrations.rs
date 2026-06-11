//! Tiny PRAGMA user_version migration runner. Each entry of
//! [`MIGRATIONS`] runs at most once, in order; the index of the highest
//! applied entry is persisted in `PRAGMA user_version`. Reproduces what
//! we'd get from `rusqlite_migration` — we hand-roll it because no
//! published `rusqlite_migration` version targets rusqlite 0.33 (the
//! version helios-persistence pins).

use rusqlite::Connection;

pub fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    let current: u32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let tx = conn.transaction()?;
    for (idx, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        tx.execute_batch(sql)?;
        let next = (idx + 1) as u32;
        // The literal is index-derived, not user input.
        tx.execute_batch(&format!("PRAGMA user_version = {next}"))?;
    }
    tx.commit()
}

/// Ordered list of schema migrations. The array index is the persisted
/// `PRAGMA user_version` — append-only; never reorder or rewrite an
/// already-shipped entry. New migrations land as a sibling `.sql` file
/// under `src/migrations/` plus one new `include_str!` line below.
const MIGRATIONS: &[&str] = &[include_str!("../migrations/001_initial_schema.sql")];

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
            "signing_keys",
        ] {
            assert!(names.iter().any(|n| n == expected), "missing {expected}");
        }
    }
}
