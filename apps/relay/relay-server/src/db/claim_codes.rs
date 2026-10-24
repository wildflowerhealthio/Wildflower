//! `claim_codes` queries — the `SQLite` adapter bodies behind
//! `SqliteTunnelStore`'s [`ClaimCodeStore`](crate::domain::ClaimCodeStore)
//! impl. Writes bind a [`NewClaimCodeRow`] borrowed from a
//! [`StoredClaimCode`], whose `tunnel_name` is `NULL` for an
//! [`Open`](ClaimCodeTarget::Open) code. A redeemed preset code's tunnel is
//! read from `tunnels` in the same transaction that deletes the code; a
//! redeemed open code's tunnel is inserted in it.

use diesel::prelude::*;
use wildflowerhealthio_persistence::PooledDieselConnection;

use crate::db::schema::{claim_codes, tunnels};
use crate::db::tunnels::NewTunnelRow;
use crate::domain::{
    ClaimCodeHash, ClaimCodeTarget, StoredClaimCode, StoredTunnel, Tunnel, TunnelError,
};
use crate::settings::Secret;

/// The `claim_codes` row as an insert binds it, borrowed from a
/// [`StoredClaimCode`].
#[derive(Insertable)]
#[diesel(table_name = claim_codes)]
struct NewClaimCodeRow<'a> {
    code_hash: &'a [u8],
    tunnel_name: Option<&'a str>,
    expires_at: i64,
}

impl<'a> From<&'a StoredClaimCode> for NewClaimCodeRow<'a> {
    fn from(stored: &'a StoredClaimCode) -> Self {
        NewClaimCodeRow {
            code_hash: &stored.code_hash.0,
            tunnel_name: preset_tunnel_name(&stored.target),
            expires_at: stored.expires_at,
        }
    }
}

/// The `tunnel_name` column of a code for `target`.
fn preset_tunnel_name(target: &ClaimCodeTarget) -> Option<&str> {
    match target {
        ClaimCodeTarget::Preset { tunnel_name } => Some(tunnel_name),
        ClaimCodeTarget::Open => None,
    }
}

/// The target a `tunnel_name` column holds.
fn target_of(tunnel_name: Option<String>) -> ClaimCodeTarget {
    tunnel_name.map_or(ClaimCodeTarget::Open, |tunnel_name| {
        ClaimCodeTarget::Preset { tunnel_name }
    })
}

/// Store `stored`, in one immediate transaction: `false`, storing nothing,
/// if a row already has its hash (the primary key); otherwise, for a preset
/// code, the tunnel's earlier code (`tunnel_name` is `UNIQUE`) is deleted
/// first. Backs
/// [`SqliteTunnelStore::insert_claim_code`](crate::db::SqliteTunnelStore).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] on a read or write failure, including a
/// tunnel name not in `tunnels` (the foreign key).
pub(super) fn insert_claim_code(
    conn: &mut PooledDieselConnection,
    stored: &StoredClaimCode,
) -> Result<bool, TunnelError> {
    conn.immediate_transaction(|conn| {
        let hash_is_stored = diesel::select(diesel::dsl::exists(
            claim_codes::table.find(&stored.code_hash.0[..]),
        ))
        .get_result::<bool>(conn)?;
        if hash_is_stored {
            return Ok(false);
        }
        if let ClaimCodeTarget::Preset { tunnel_name } = &stored.target {
            diesel::delete(claim_codes::table.filter(claim_codes::tunnel_name.eq(tunnel_name)))
                .execute(conn)?;
        }
        diesel::insert_into(claim_codes::table)
            .values(NewClaimCodeRow::from(stored))
            .execute(conn)?;
        Ok(true)
    })
    .map_err(|e: diesel::result::Error| {
        TunnelError::infrastructure("storing the claim code failed", e)
    })
}

/// What the code hashed `code_hash` redeems for, if it expires after `now`.
/// Backs
/// [`SqliteTunnelStore::claim_code_target`](crate::db::SqliteTunnelStore).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] on a read failure.
pub(super) fn claim_code_target(
    conn: &mut PooledDieselConnection,
    code_hash: &ClaimCodeHash,
    now: i64,
) -> Result<Option<ClaimCodeTarget>, TunnelError> {
    claim_codes::table
        .find(&code_hash.0[..])
        .filter(claim_codes::expires_at.gt(now))
        .select(claim_codes::tunnel_name)
        .first::<Option<String>>(conn)
        .optional()
        .map(|tunnel_name| tunnel_name.map(target_of))
        .map_err(|e| TunnelError::infrastructure("reading the claim codes failed", e))
}

/// Delete the preset code hashed `code_hash` if it expires after `now`, and
/// read the tunnel it named, in one immediate transaction. The delete is
/// what burns the code: of concurrent calls, only the one whose delete
/// removes the row gets the tunnel. Backs
/// [`SqliteTunnelStore::take_preset_claim_code`](crate::db::SqliteTunnelStore).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] on a delete or read failure.
pub(super) fn take_preset_claim_code(
    conn: &mut PooledDieselConnection,
    code_hash: &ClaimCodeHash,
    now: i64,
) -> Result<Option<Tunnel>, TunnelError> {
    conn.immediate_transaction(|conn| {
        let unexpired = claim_codes::table
            .find(&code_hash.0[..])
            .filter(claim_codes::tunnel_name.is_not_null())
            .filter(claim_codes::expires_at.gt(now));
        let Some(Some(tunnel_name)) = diesel::delete(unexpired)
            .returning(claim_codes::tunnel_name)
            .get_result::<Option<String>>(conn)
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

/// Delete the open code hashed `code_hash` if it expires after `now`, and
/// insert `tunnel`, in one immediate transaction. The delete is what burns
/// the code: of concurrent calls, only the one whose delete removes the row
/// inserts its tunnel. A name already stored fails the insert and rolls the
/// delete back. Backs
/// [`SqliteTunnelStore::take_open_claim_code_for_tunnel`](crate::db::SqliteTunnelStore).
///
/// # Errors
///
/// [`TunnelError::Infrastructure`] on a delete or insert failure.
pub(super) fn take_open_claim_code_for_tunnel(
    conn: &mut PooledDieselConnection,
    code_hash: &ClaimCodeHash,
    now: i64,
    tunnel: &StoredTunnel,
) -> Result<Option<StoredClaimCode>, TunnelError> {
    conn.immediate_transaction(|conn| {
        let unexpired = claim_codes::table
            .find(&code_hash.0[..])
            .filter(claim_codes::tunnel_name.is_null())
            .filter(claim_codes::expires_at.gt(now));
        let Some(expires_at) = diesel::delete(unexpired)
            .returning(claim_codes::expires_at)
            .get_result::<i64>(conn)
            .optional()?
        else {
            return Ok(None);
        };
        diesel::insert_into(tunnels::table)
            .values(NewTunnelRow::from(tunnel))
            .execute(conn)?;
        Ok(Some(StoredClaimCode {
            code_hash: *code_hash,
            target: ClaimCodeTarget::Open,
            expires_at,
        }))
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
