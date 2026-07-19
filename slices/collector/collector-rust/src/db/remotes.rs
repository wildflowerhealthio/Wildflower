//! The `collector_remotes` CRUD query bodies — the `pub(super)` free functions
//! the [`SqliteRemotesStore`](super::SqliteRemotesStore) `impl` delegates to,
//! each running on a connection the store has already checked out of the pool
//! (see [`SqliteRemotesStore::connection`](super::SqliteRemotesStore)). They
//! return the port's PRIMITIVE shapes (absence as `None`, insert/delete outcome
//! as `bool`) and raise only [`RemoteError::Infrastructure`] on a real db
//! failure; the semantic `NotFound`/`AlreadyExists` decisions live one layer up
//! in [`crate::domain::capabilities`]. The query SQL stays here, next to the
//! [`Remote`] row type it maps (via [`JsonText`] for the `config` column).

use diesel::prelude::*;
use persistence_rust::PooledDieselConnection;

use crate::db::schema::collector_remotes;
use crate::domain::{Remote, RemoteError};
use shared_structures_rust::json_text::JsonText;

/// Every remote, oldest first (ties broken by id so the order is total).
pub(super) fn list(conn: &mut PooledDieselConnection) -> Result<Vec<Remote>, RemoteError> {
    collector_remotes::table
        .order((collector_remotes::added_at, collector_remotes::id))
        .select(Remote::as_select())
        .load(conn)
        .map_err(|e| RemoteError::infrastructure("list_remotes failed", e))
}

/// A single remote by id, or `None` when absent.
pub(super) fn get(
    conn: &mut PooledDieselConnection,
    id: &str,
) -> Result<Option<Remote>, RemoteError> {
    collector_remotes::table
        .find(id)
        .select(Remote::as_select())
        .first(conn)
        .optional()
        .map_err(|e| RemoteError::infrastructure("get_remote failed", e))
}

/// Insert a fresh remote (`INSERT … ON CONFLICT(id) DO NOTHING`). Returns `true`
/// when the row was written, `false` when the id was already taken (0 rows
/// affected) — a conflict rather than a silent overwrite.
pub(super) fn insert(
    conn: &mut PooledDieselConnection,
    remote: &Remote,
) -> Result<bool, RemoteError> {
    let affected = diesel::insert_into(collector_remotes::table)
        // `Remote`'s `config` uses `#[diesel(serialize_as)]`, which consumes the
        // value — diesel generates no borrowed `Insertable` impl for the struct,
        // so the insert takes a clone.
        .values(remote.clone())
        .on_conflict(collector_remotes::id)
        .do_nothing()
        .execute(conn)
        .map_err(|e| RemoteError::infrastructure("insert_remote failed", e))?;
    Ok(affected == 1)
}

/// Update an existing remote's `name` / `tag` / `config` (id and `added_at` are
/// immutable) and return the resulting row, or `None` when no remote has this
/// id. A single `UPDATE … RETURNING` statement, so the write and the returned
/// row are atomic — the row can't reflect a concurrent write, and a concurrent
/// delete can't produce an updated-but-gone race.
pub(super) fn update(
    conn: &mut PooledDieselConnection,
    id: &str,
    name: &str,
    tag: &str,
    config: &serde_json::Value,
) -> Result<Option<Remote>, RemoteError> {
    diesel::update(collector_remotes::table.find(id))
        .set((
            collector_remotes::name.eq(name),
            collector_remotes::tag.eq(tag),
            collector_remotes::config.eq(JsonText::from(config.clone())),
        ))
        .returning(Remote::as_returning())
        .get_result(conn)
        .optional()
        .map_err(|e| RemoteError::infrastructure("update_remote failed", e))
}

/// Remove a remote by id. Returns `true` when a row was removed, `false` when no
/// remote had this id.
pub(super) fn delete(conn: &mut PooledDieselConnection, id: &str) -> Result<bool, RemoteError> {
    let affected = diesel::delete(collector_remotes::table.find(id))
        .execute(conn)
        .map_err(|e| RemoteError::infrastructure("delete_remote failed", e))?;
    Ok(affected == 1)
}
