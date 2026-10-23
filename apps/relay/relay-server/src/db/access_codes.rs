//! `access_codes` queries — the `SQLite` adapter bodies behind
//! `SqliteTunnelStore`'s [`AccessCodeStore`](crate::domain::AccessCodeStore)
//! impl. Writes bind a [`NewAccessCodeRow`] borrowed from a
//! [`StoredAccessCode`]; a redeemed code is deleted in the same transaction
//! that inserts the tunnel it redeemed for.

use diesel::prelude::*;
use wildflowerhealthio_persistence::PooledDieselConnection;

use crate::db::schema::{access_codes, claim_codes, tunnels};
use crate::db::tunnels::NewTunnelRow;
use crate::domain::{ClaimCodeHash, StoredAccessCode, StoredTunnel, TunnelError};

/// The `access_codes` row as an insert binds it, borrowed from a
/// [`StoredAccessCode`].
#[derive(Insertable)]
#[diesel(table_name = access_codes)]
struct NewAccessCodeRow<'a> {
    code_hash: &'a [u8],
    expires_at: i64,
}

impl<'a> From<&'a StoredAccessCode> for NewAccessCodeRow<'a> {
    fn from(stored: &'a StoredAccessCode) -> Self {
        NewAccessCodeRow {
            code_hash: &stored.code_hash.0,
            expires_at: stored.expires_at,
        }
    }
}

/// Insert `stored`, in one immediate transaction: `false`, storing nothing,
/// if an access code (the primary key) or a claim code already has its
/// hash. Backs
/// [`SqliteTunnelStore::insert_access_code`](crate::db::SqliteTunnelStore).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] on a read or write failure.
pub(super) fn insert_access_code(
    conn: &mut PooledDieselConnection,
    stored: &StoredAccessCode,
) -> Result<bool, TunnelError> {
    conn.immediate_transaction(|conn| {
        let hash = &stored.code_hash.0[..];
        let claim_code_has_hash = diesel::select(diesel::dsl::exists(
            claim_codes::table.filter(claim_codes::code_hash.eq(hash)),
        ))
        .get_result::<bool>(conn)?;
        if claim_code_has_hash {
            return Ok(false);
        }
        diesel::insert_into(access_codes::table)
            .values(NewAccessCodeRow::from(stored))
            .on_conflict(access_codes::code_hash)
            .do_nothing()
            .execute(conn)
            .map(|inserted| inserted > 0)
    })
    .map_err(|e: diesel::result::Error| {
        TunnelError::infrastructure("storing the access code failed", e)
    })
}

/// Whether an access code hashed `code_hash` expires after `now`. Backs
/// [`SqliteTunnelStore::contains_access_code`](crate::db::SqliteTunnelStore).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] on a read failure.
pub(super) fn contains_access_code(
    conn: &mut PooledDieselConnection,
    code_hash: &ClaimCodeHash,
    now: i64,
) -> Result<bool, TunnelError> {
    diesel::select(diesel::dsl::exists(
        access_codes::table
            .find(&code_hash.0[..])
            .filter(access_codes::expires_at.gt(now)),
    ))
    .get_result(conn)
    .map_err(|e| TunnelError::infrastructure("reading the access codes failed", e))
}

/// Delete the access code hashed `code_hash` if it expires after `now`, and
/// insert `tunnel`, in one immediate transaction. The delete is what burns
/// the code: of concurrent calls, only the one whose delete removes the row
/// inserts its tunnel. A name already stored fails the insert and rolls the
/// delete back. Backs
/// [`SqliteTunnelStore::take_access_code_for_tunnel`](crate::db::SqliteTunnelStore).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] on a delete or insert failure.
pub(super) fn take_access_code_for_tunnel(
    conn: &mut PooledDieselConnection,
    code_hash: &ClaimCodeHash,
    now: i64,
    tunnel: &StoredTunnel,
) -> Result<Option<StoredAccessCode>, TunnelError> {
    conn.immediate_transaction(|conn| {
        let unexpired = access_codes::table
            .find(&code_hash.0[..])
            .filter(access_codes::expires_at.gt(now));
        let Some(expires_at) = diesel::delete(unexpired)
            .returning(access_codes::expires_at)
            .get_result::<i64>(conn)
            .optional()?
        else {
            return Ok(None);
        };
        diesel::insert_into(tunnels::table)
            .values(NewTunnelRow::from(tunnel))
            .execute(conn)?;
        Ok(Some(StoredAccessCode {
            code_hash: *code_hash,
            expires_at,
        }))
    })
    .map_err(|e: diesel::result::Error| {
        TunnelError::infrastructure("redeeming the access code failed", e)
    })
}

/// Delete every access code that expires at or before `now`, returning how
/// many. Backs
/// [`SqliteTunnelStore::delete_expired_access_codes`](crate::db::SqliteTunnelStore).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] on a delete failure.
pub(super) fn delete_expired_access_codes(
    conn: &mut PooledDieselConnection,
    now: i64,
) -> Result<usize, TunnelError> {
    diesel::delete(access_codes::table.filter(access_codes::expires_at.le(now)))
        .execute(conn)
        .map_err(|e| TunnelError::infrastructure("deleting expired access codes failed", e))
}
