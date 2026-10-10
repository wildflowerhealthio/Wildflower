//! `tunnels` queries — the `SQLite` adapter bodies behind
//! `SqliteTunnelStore`'s [`TunnelStore`](crate::domain::TunnelStore) impl.
//! Rows are loaded into a [`TunnelRow`] via diesel and folded into the
//! domain [`StoredTunnel`]; writes bind a [`NewTunnelRow`] borrowed from one.

use diesel::prelude::*;
use wildflowerhealthio_persistence::PooledDieselConnection;

use crate::db::schema::tunnels;
use crate::domain::Tunnel;
use crate::domain::{StoredTunnel, TunnelError};
use crate::settings::Secret;

/// The `tunnels` row as diesel loads it, before it's folded into the domain
/// [`StoredTunnel`] (which nests the name and token as a [`Tunnel`]).
#[derive(Debug, Queryable, Selectable)]
#[diesel(table_name = tunnels)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub(super) struct TunnelRow {
    name: String,
    email: String,
    token: String,
    created_at: i64,
}

impl From<TunnelRow> for StoredTunnel {
    fn from(row: TunnelRow) -> Self {
        StoredTunnel {
            tunnel: Tunnel {
                name: row.name,
                token: Secret::new(row.token),
            },
            email: row.email,
            created_at: row.created_at,
        }
    }
}

/// The `tunnels` row as an insert binds it, borrowed from a [`StoredTunnel`].
#[derive(Insertable)]
#[diesel(table_name = tunnels)]
struct NewTunnelRow<'a> {
    name: &'a str,
    email: &'a str,
    token: &'a str,
    created_at: i64,
}

impl<'a> From<&'a StoredTunnel> for NewTunnelRow<'a> {
    fn from(stored: &'a StoredTunnel) -> Self {
        NewTunnelRow {
            name: &stored.tunnel.name,
            email: &stored.email,
            token: stored.tunnel.token.expose(),
            created_at: stored.created_at,
        }
    }
}

/// Every stored tunnel, by name. Backs
/// [`SqliteTunnelStore::list_tunnels`](crate::db::SqliteTunnelStore).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] on a read failure.
pub(super) fn list_tunnels(
    conn: &mut PooledDieselConnection,
) -> Result<Vec<StoredTunnel>, TunnelError> {
    tunnels::table
        .order(tunnels::name)
        .select(TunnelRow::as_select())
        .load(conn)
        .map(|rows| rows.into_iter().map(StoredTunnel::from).collect())
        .map_err(|e| TunnelError::infrastructure("reading the stored tunnels failed", e))
}

/// Whether a tunnel named `name` is stored. Backs
/// [`SqliteTunnelStore::contains_tunnel`](crate::db::SqliteTunnelStore).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] on a read failure.
pub(super) fn contains_tunnel(
    conn: &mut PooledDieselConnection,
    name: &str,
) -> Result<bool, TunnelError> {
    diesel::select(diesel::dsl::exists(tunnels::table.find(name)))
        .get_result(conn)
        .map_err(|e| TunnelError::infrastructure("reading the stored tunnels failed", e))
}

/// Add `stored`; `false`, storing nothing, if the name is already stored
/// (the primary key). Backs
/// [`SqliteTunnelStore::insert_tunnel`](crate::db::SqliteTunnelStore).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] on an insert failure.
pub(super) fn insert_tunnel(
    conn: &mut PooledDieselConnection,
    stored: &StoredTunnel,
) -> Result<bool, TunnelError> {
    diesel::insert_into(tunnels::table)
        .values(NewTunnelRow::from(stored))
        .on_conflict(tunnels::name)
        .do_nothing()
        .execute(conn)
        .map(|inserted| inserted > 0)
        .map_err(|e| TunnelError::infrastructure("storing the tunnel failed", e))
}

/// Remove the tunnel named `name`, returning it; `None` if there was none.
/// Backs [`SqliteTunnelStore::delete_tunnel`](crate::db::SqliteTunnelStore).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] on a delete failure.
pub(super) fn delete_tunnel(
    conn: &mut PooledDieselConnection,
    name: &str,
) -> Result<Option<StoredTunnel>, TunnelError> {
    diesel::delete(tunnels::table.find(name))
        .returning(TunnelRow::as_returning())
        .get_result(conn)
        .optional()
        .map(|row| row.map(StoredTunnel::from))
        .map_err(|e| TunnelError::infrastructure("deleting the stored tunnel failed", e))
}
