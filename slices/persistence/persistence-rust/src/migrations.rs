//! Tiny `PRAGMA user_version` migration runner. Each entry of the supplied
//! `migrations` slice runs at most once, in order; the index of the highest
//! applied entry is persisted in `PRAGMA user_version`. Reproduces what we'd
//! get from `rusqlite_migration` — we hand-roll it because no published
//! `rusqlite_migration` version targets rusqlite 0.33 (the version
//! helios-persistence pins).
//!
//! Each slice owns its own append-only `migrations` list (e.g. an array of
//! `include_str!`'d `.sql` files) and calls this runner from its store's open
//! path.

use rusqlite::Connection;

/// Apply pending migrations from `migrations` to `conn`.
///
/// `migrations` is treated as append-only: index `i` corresponds to
/// `user_version == i + 1`. Never reorder or rewrite an already-shipped entry.
///
/// # Errors
///
/// Returns any rusqlite error from reading `user_version`, executing a
/// migration batch, or committing it.
pub fn run_migrations(conn: &mut Connection, migrations: &[&str]) -> rusqlite::Result<()> {
    let current: usize = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    for (idx, sql) in migrations.iter().enumerate().skip(current) {
        // One transaction per migration so each lands (and bumps
        // `user_version`) atomically and independently: a failure in a later
        // migration can't roll back an already-validated earlier one, and the
        // version always reflects exactly what is committed.
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        // `idx` is an index into the caller's `migrations` slice, so the next
        // version is simply `idx + 1`. `pragma_update` binds the value as a
        // parameter, so there's no SQL string to interpolate.
        tx.pragma_update(None, "user_version", idx + 1)?;
        tx.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIGRATIONS: &[&str] = &[
        "CREATE TABLE a (id INTEGER PRIMARY KEY);",
        "CREATE TABLE b (id INTEGER PRIMARY KEY);",
    ];

    #[test]
    fn applies_all_and_sets_user_version() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn, MIGRATIONS).unwrap();
        let v: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(v as usize, MIGRATIONS.len());
    }

    #[test]
    fn is_idempotent_and_only_runs_pending() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn, MIGRATIONS).unwrap();
        // A second full run must be a no-op — re-running migration 0
        // (`CREATE TABLE a`) would error with "table already exists" if the
        // `skip(current)` guard regressed.
        run_migrations(&mut conn, MIGRATIONS).unwrap();
        let v: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(v as usize, MIGRATIONS.len());
    }

    #[test]
    fn resumes_from_partial_version() {
        let mut conn = Connection::open_in_memory().unwrap();
        // Pretend migration 0 already ran.
        run_migrations(&mut conn, &MIGRATIONS[..1]).unwrap();
        // Now run the full list — only migration 1 should apply.
        run_migrations(&mut conn, MIGRATIONS).unwrap();
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(tables.iter().any(|t| t == "a"));
        assert!(tables.iter().any(|t| t == "b"));
    }
}
