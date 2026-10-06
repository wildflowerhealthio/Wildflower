//! The tunnel slice's migrations in the shared database. The tunnel keeps no
//! rows: a server's relay settings and public host come from its record, which
//! the host hands [`setup_tunnel`](crate::setup_tunnel). The migrations still
//! run so a database that holds the slice's old tables has them dropped.

use anyhow::Context;
use diesel_migrations::{embed_migrations, EmbeddedMigrations};
use persistence_rust::DieselPool;

/// This slice's migration namespace in the shared database. Applied versions are
/// bookkept per-namespace by [`persistence_rust::run_diesel_migrations`], so
/// tunnel's `0001` and another diesel slice's `0001` never collide.
const MIGRATION_NAMESPACE: &str = "tunnel";

/// The tunnel migrations, embedded from the crate's `migrations/` tree at
/// compile time (diesel layout: `<version>_<name>/up.sql` + `down.sql`).
/// Applied by [`run_migrations`] via [`persistence_rust::run_diesel_migrations`]
/// under [`MIGRATION_NAMESPACE`] (see that runner for why the stock diesel
/// harness can't be used). Migration `0001` uses idempotent DDL so it's a no-op
/// on a database whose `tunnel_settings` table predates this diesel migration
/// (see its `up.sql`); `0004` drops that table.
const MIGRATIONS: EmbeddedMigrations = embed_migrations!();

/// Apply pending tunnel migrations to the shared database behind `pool`, on a
/// single checked-out connection.
///
/// # Errors
///
/// Returns an error if a connection can't be checked out of the pool or a
/// migration fails.
pub(crate) fn run_migrations(pool: &DieselPool) -> anyhow::Result<()> {
    let mut conn = pool
        .get()
        .context("failed to check out a connection to run tunnel migrations")?;
    persistence_rust::run_diesel_migrations(&mut conn, MIGRATION_NAMESPACE, MIGRATIONS)
        .context("failed to apply tunnel migrations")
}

#[cfg(test)]
mod tests {
    use diesel::prelude::*;

    use super::*;

    #[derive(QueryableByName)]
    struct TableCount {
        #[diesel(sql_type = diesel::sql_types::BigInt)]
        count: i64,
    }

    /// How many tables named `table` the database behind `conn` holds.
    fn tables_named(conn: &mut SqliteConnection, table: &str) -> i64 {
        diesel::sql_query(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .bind::<diesel::sql_types::Text, _>(table)
        .get_result::<TableCount>(conn)
        .expect("sqlite_master reads")
        .count
    }

    /// Running the migrations twice is a no-op the second time (the namespaced
    /// runner skips already-applied versions), so opening an existing database
    /// never errors.
    #[test]
    fn migrations_are_idempotent() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        run_migrations(&pool).unwrap();
        run_migrations(&pool).unwrap();
    }

    /// The migrations leave neither of the slice's old tables behind: `0003`
    /// drops the `tunnel_requests` table `0002` created, and `0004` drops the
    /// `tunnel_settings` table `0001` created.
    #[test]
    fn migrations_leave_no_tunnel_tables() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        run_migrations(&pool).unwrap();
        let mut conn = pool.get().unwrap();
        assert_eq!(tables_named(&mut conn, "tunnel_requests"), 0);
        assert_eq!(tables_named(&mut conn, "tunnel_settings"), 0);
    }

    /// A database that holds a configured `tunnel_settings` row from before the
    /// settings moved to the server record has the table dropped, row and all.
    #[test]
    fn migrations_drop_a_configured_tunnel_settings_table() {
        let pool = persistence_rust::open_in_memory_pool().unwrap();
        let mut conn = pool.get().unwrap();
        diesel::sql_query(
            "CREATE TABLE tunnel_settings (\
                id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, public_host TEXT, \
                requested_running INTEGER NOT NULL DEFAULT 0, relay_remote_addr TEXT, \
                relay_token TEXT, relay_public_key TEXT, service_name TEXT) STRICT;",
        )
        .execute(&mut conn)
        .unwrap();
        diesel::sql_query(
            "INSERT INTO tunnel_settings (id, revision, public_host, requested_running, \
             relay_token) VALUES ('tunnel', 7, 'dev1.example.com', 1, 'tok')",
        )
        .execute(&mut conn)
        .unwrap();
        drop(conn);

        run_migrations(&pool).unwrap();

        let mut conn = pool.get().unwrap();
        assert_eq!(tables_named(&mut conn, "tunnel_settings"), 0);
    }
}
