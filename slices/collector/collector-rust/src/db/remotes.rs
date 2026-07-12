//! The `collector_remotes` CRUD query bodies — the `pub(super)` free functions
//! the [`SqliteRemotesStore`](super::SqliteRemotesStore) `impl` delegates to,
//! each taking a checked-out connection from the pool it's handed. They return
//! the port's PRIMITIVE shapes (absence as `None`, insert/delete outcome as
//! `bool`) and raise only [`RemoteError::Infrastructure`] on a real db/pool
//! failure; the semantic `NotFound`/`AlreadyExists` decisions live one layer up
//! in [`crate::domain::actions`]. The query SQL stays here, next to the
//! [`Remote`] row type it maps (via [`JsonText`] for the `config` column).

use diesel::prelude::*;
use persistence_rust::DieselPool;

use crate::db::schema::collector_remotes;
use crate::domain::{Remote, RemoteError};
use shared_structures_rust::json_text::JsonText;

/// Every remote, oldest first (ties broken by id so the order is total).
pub(super) fn list(pool: &DieselPool) -> Result<Vec<Remote>, RemoteError> {
    let mut conn = pool
        .get()
        .map_err(|e| RemoteError::infrastructure("failed to check out a connection", e))?;
    collector_remotes::table
        .order((collector_remotes::added_at, collector_remotes::id))
        .select(Remote::as_select())
        .load(&mut conn)
        .map_err(|e| RemoteError::infrastructure("list_remotes failed", e))
}

/// A single remote by id, or `None` when absent.
pub(super) fn get(pool: &DieselPool, id: &str) -> Result<Option<Remote>, RemoteError> {
    let mut conn = pool
        .get()
        .map_err(|e| RemoteError::infrastructure("failed to check out a connection", e))?;
    collector_remotes::table
        .find(id)
        .select(Remote::as_select())
        .first(&mut conn)
        .optional()
        .map_err(|e| RemoteError::infrastructure("get_remote failed", e))
}

/// Insert a fresh remote (`INSERT … ON CONFLICT(id) DO NOTHING`). Returns `true`
/// when the row was written, `false` when the id was already taken (0 rows
/// affected) — a conflict rather than a silent overwrite.
pub(super) fn insert(pool: &DieselPool, remote: &Remote) -> Result<bool, RemoteError> {
    let mut conn = pool
        .get()
        .map_err(|e| RemoteError::infrastructure("failed to check out a connection", e))?;
    let affected = diesel::insert_into(collector_remotes::table)
        // `Remote`'s `config` uses `#[diesel(serialize_as)]`, which consumes the
        // value — diesel generates no borrowed `Insertable` impl for the struct,
        // so the insert takes a clone.
        .values(remote.clone())
        .on_conflict(collector_remotes::id)
        .do_nothing()
        .execute(&mut conn)
        .map_err(|e| RemoteError::infrastructure("insert_remote failed", e))?;
    Ok(affected == 1)
}

/// Update an existing remote's `name` / `tag` / `config` (id and `added_at` are
/// immutable) and return the resulting row, or `None` when no remote has this
/// id. A single `UPDATE … RETURNING` statement, so the write and the returned
/// row are atomic — the row can't reflect a concurrent write, and a concurrent
/// delete can't produce an updated-but-gone race.
pub(super) fn update(
    pool: &DieselPool,
    id: &str,
    name: &str,
    tag: &str,
    config: &serde_json::Value,
) -> Result<Option<Remote>, RemoteError> {
    let mut conn = pool
        .get()
        .map_err(|e| RemoteError::infrastructure("failed to check out a connection", e))?;
    diesel::update(collector_remotes::table.find(id))
        .set((
            collector_remotes::name.eq(name),
            collector_remotes::tag.eq(tag),
            collector_remotes::config.eq(JsonText::from(config.clone())),
        ))
        .returning(Remote::as_returning())
        .get_result(&mut conn)
        .optional()
        .map_err(|e| RemoteError::infrastructure("update_remote failed", e))
}

/// Remove a remote by id. Returns `true` when a row was removed, `false` when no
/// remote had this id.
pub(super) fn delete(pool: &DieselPool, id: &str) -> Result<bool, RemoteError> {
    let mut conn = pool
        .get()
        .map_err(|e| RemoteError::infrastructure("failed to check out a connection", e))?;
    let affected = diesel::delete(collector_remotes::table.find(id))
        .execute(&mut conn)
        .map_err(|e| RemoteError::infrastructure("delete_remote failed", e))?;
    Ok(affected == 1)
}
