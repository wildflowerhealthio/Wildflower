//! `claim_codes` queries — the `SQLite` adapter bodies behind
//! `SqliteTunnelStore`'s [`ClaimCodeStore`](crate::domain::ClaimCodeStore)
//! impl. Writes bind a [`NewClaimCodeRow`] borrowed from a
//! [`StoredClaimCode`]; a redeemed code's tunnel is read from `tunnels` in
//! the same transaction that deletes the code.

use diesel::prelude::*;
use wildflowerhealthio_persistence::PooledDieselConnection;

use crate::db::schema::{claim_codes, tunnels};
use crate::domain::{ClaimCodeHash, StoredClaimCode, Tunnel, TunnelError};
use crate::settings::Secret;

/// The `claim_codes` row as an insert binds it, borrowed from a
/// [`StoredClaimCode`].
#[derive(Insertable)]
#[diesel(table_name = claim_codes)]
struct NewClaimCodeRow<'a> {
    code_hash: &'a [u8],
    tunnel_name: &'a str,
    expires_at: i64,
}

impl<'a> From<&'a StoredClaimCode> for NewClaimCodeRow<'a> {
    fn from(stored: &'a StoredClaimCode) -> Self {
        NewClaimCodeRow {
            code_hash: &stored.code_hash.0,
            tunnel_name: &stored.tunnel_name,
            expires_at: stored.expires_at,
        }
    }
}

/// Add `stored`; `false`, storing nothing, if its hash is already stored
/// (the primary key). Backs
/// [`SqliteTunnelStore::insert_claim_code`](crate::db::SqliteTunnelStore).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] on an insert failure, including a tunnel
/// name not in `tunnels` (the foreign key).
pub(super) fn insert_claim_code(
    conn: &mut PooledDieselConnection,
    stored: &StoredClaimCode,
) -> Result<bool, TunnelError> {
    diesel::insert_into(claim_codes::table)
        .values(NewClaimCodeRow::from(stored))
        .on_conflict(claim_codes::code_hash)
        .do_nothing()
        .execute(conn)
        .map(|inserted| inserted > 0)
        .map_err(|e| TunnelError::infrastructure("storing the claim code failed", e))
}

/// Delete the code hashed `code_hash` if it expires after `now`, and read
/// the tunnel it named, in one immediate transaction. The delete is what
/// burns the code: of concurrent calls, only the one whose delete removes
/// the row gets the tunnel. Backs
/// [`SqliteTunnelStore::take_claim_code`](crate::db::SqliteTunnelStore).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] on a delete or read failure.
pub(super) fn take_claim_code(
    conn: &mut PooledDieselConnection,
    code_hash: &ClaimCodeHash,
    now: i64,
) -> Result<Option<Tunnel>, TunnelError> {
    conn.immediate_transaction(|conn| {
        let unexpired = claim_codes::table
            .filter(claim_codes::code_hash.eq(&code_hash.0[..]))
            .filter(claim_codes::expires_at.gt(now));
        let Some(tunnel_name) = diesel::delete(unexpired)
            .returning(claim_codes::tunnel_name)
            .get_result::<String>(conn)
            .optional()?
        else {
            return Ok(None);
        };
        tunnels::table
            .find(&tunnel_name)
            .select((tunnels::name, tunnels::token))
            .first::<(String, String)>(conn)
            .optional()
    })
    .map(|tunnel| {
        tunnel.map(|(name, token)| Tunnel {
            name,
            token: Secret::new(token),
        })
    })
    .map_err(|e: diesel::result::Error| {
        TunnelError::infrastructure("redeeming the claim code failed", e)
    })
}

/// Delete every code that expires at or before `now`, returning how many.
/// Backs
/// [`SqliteTunnelStore::delete_expired_claim_codes`](crate::db::SqliteTunnelStore).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] on a delete failure.
pub(super) fn delete_expired_claim_codes(
    conn: &mut PooledDieselConnection,
    now: i64,
) -> Result<usize, TunnelError> {
    diesel::delete(claim_codes::table.filter(claim_codes::expires_at.le(now)))
        .execute(conn)
        .map_err(|e| TunnelError::infrastructure("deleting expired claim codes failed", e))
}
