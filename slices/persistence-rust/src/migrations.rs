//! A tiny migration runner keyed on a per-slice `namespace`, so multiple
//! slices can share one `SQLite` database without their `user_version`s
//! colliding. Applied versions are tracked in a `schema_migrations` table
//! (`namespace` -> highest applied index). Each slice's `migrations` slice is
//! append-only; the runner applies each pending entry once, in order.

use rusqlite::{params, Connection, OptionalExtension};

/// Apply pending `migrations` for `namespace` to `conn`.
///
/// `migrations` is treated as append-only: index `i` corresponds to version
/// `i + 1`. Never reorder or rewrite an already-shipped entry.
///
/// # Errors
///
/// Returns any rusqlite error from reading/recording the version or executing
/// a migration batch.
pub fn run_migrations(
    conn: &mut Connection,
    namespace: &str,
    migrations: &[&str],
) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (\
            namespace TEXT PRIMARY KEY, \
            version INTEGER NOT NULL\
         ) STRICT;",
    )?;
    let current: i64 = conn
        .query_row(
            "SELECT version FROM schema_migrations WHERE namespace = ?1",
            [namespace],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0);
    // A missing row means a fresh namespace (version 0, handled above). A row
    // that's present but negative/out-of-range means `schema_migrations` was
    // corrupted or hand-edited; fail loudly rather than silently restarting
    // from 0, which would replay migrations against an already-populated schema
    // and error on the first `CREATE TABLE`.
    let current = usize::try_from(current)
        .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(0, current))?;

    for (idx, sql) in migrations.iter().enumerate().skip(current) {
        // One transaction per migration so each lands (and bumps the recorded
        // version) atomically and independently.
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        let next = i64::try_from(idx + 1)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        tx.execute(
            "INSERT INTO schema_migrations (namespace, version) VALUES (?1, ?2) \
             ON CONFLICT(namespace) DO UPDATE SET version = excluded.version",
            params![namespace, next],
        )?;
        tx.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &[&str] = &[
        "CREATE TABLE a (id INTEGER PRIMARY KEY);",
        "CREATE TABLE b (id INTEGER PRIMARY KEY);",
    ];
    const C: &[&str] = &["CREATE TABLE c (id INTEGER PRIMARY KEY);"];

    fn version(conn: &Connection, namespace: &str) -> i64 {
        conn.query_row(
            "SELECT version FROM schema_migrations WHERE namespace = ?1",
            [namespace],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
        .unwrap_or(0)
    }

    #[test]
    fn applies_all_and_records_version() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn, "x", A).unwrap();
        assert_eq!(version(&conn, "x") as usize, A.len());
    }

    #[test]
    fn is_idempotent_and_only_runs_pending() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn, "x", &A[..1]).unwrap();
        run_migrations(&mut conn, "x", A).unwrap();
        // re-running the full list is a no-op (re-running `CREATE TABLE a` would
        // error if the skip guard regressed).
        run_migrations(&mut conn, "x", A).unwrap();
        assert_eq!(version(&conn, "x") as usize, A.len());
    }

    #[test]
    fn errors_on_corrupt_negative_version_rather_than_restarting() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn, "x", A).unwrap();
        // Corrupt the recorded version to a negative value, as a hand-edit or
        // on-disk corruption might. The runner must surface an error, not
        // silently treat it as version 0 and replay `CREATE TABLE a`.
        conn.execute(
            "UPDATE schema_migrations SET version = -1 WHERE namespace = ?1",
            ["x"],
        )
        .unwrap();
        let err = run_migrations(&mut conn, "x", A).unwrap_err();
        assert!(
            matches!(err, rusqlite::Error::IntegralValueOutOfRange(_, -1)),
            "expected out-of-range error, got {err:?}"
        );
    }

    #[test]
    fn namespaces_share_one_database_without_colliding() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn, "x", A).unwrap();
        run_migrations(&mut conn, "y", C).unwrap();
        assert_eq!(version(&conn, "x") as usize, A.len());
        assert_eq!(version(&conn, "y") as usize, C.len());
        for table in ["a", "b", "c"] {
            let exists: bool = conn
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |_| Ok(true),
                )
                .unwrap_or(false);
            assert!(exists, "missing {table}");
        }
    }
}
