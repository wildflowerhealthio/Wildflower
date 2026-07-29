//! `refresh_token_families` / `refresh_tokens` queries — the rotating
//! refresh-token lineage (RFC 6749 §6, OAuth 2.1 rotation semantics), loaded
//! and stored as [`RefreshTokenFamily`] / [`RefreshToken`].

use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::sqlite::SqliteConnection;

use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::refresh_token::{RefreshToken, RefreshTokenFamily};

diesel::table! {
    refresh_token_families (family_id) {
        family_id -> Text,
        client_id -> Text,
        scopes -> Text,
        patient -> Nullable<Text>,
        issued_at -> TimestamptzSqlite,
        expires_at -> TimestamptzSqlite,
        authorization_code_hash -> Nullable<Text>,
        grant_id -> Nullable<Text>,
    }
}

diesel::table! {
    refresh_tokens (token_hash) {
        token_hash -> Text,
        family_id -> Text,
        issued_at -> TimestamptzSqlite,
        consumed_at -> Nullable<TimestamptzSqlite>,
    }
}

diesel::joinable!(refresh_tokens -> refresh_token_families (family_id));
diesel::allow_tables_to_appear_in_same_query!(refresh_tokens, refresh_token_families);

/// Persist a new refresh-token family **row only** — a single-table insert. The
/// [`insert_refresh_token_family`](crate::domain::refresh_token::insert_refresh_token_family)
/// action sequences this then [`insert_refresh_token`] so a family never persists
/// tokenless; the store stays a primitive with no transaction.
pub(super) fn insert_refresh_token_family_row(
    conn: &mut SqliteConnection,
    family: &RefreshTokenFamily,
) -> Result<(), GatekeeperError> {
    diesel::insert_into(refresh_token_families::table)
        .values(family.clone())
        .execute(conn)
        .map_err(|e| {
            GatekeeperError::infrastructure("insert_refresh_token_family_row failed", e)
        })?;
    Ok(())
}

/// Persist a single refresh-token row into an existing family — a rotation
/// successor, or the family's first token (sequenced after the family row by the
/// [`insert_refresh_token_family`](crate::domain::refresh_token::insert_refresh_token_family)
/// action).
pub(super) fn insert_refresh_token(
    conn: &mut SqliteConnection,
    token: &RefreshToken,
) -> Result<(), GatekeeperError> {
    diesel::insert_into(refresh_tokens::table)
        .values(token.clone())
        .execute(conn)
        .map_err(|e| GatekeeperError::infrastructure("insert_refresh_token failed", e))?;
    Ok(())
}

/// Resolve a presented token hash to its row plus the owning family in
/// one JOIN. Consumed tokens resolve too — the caller distinguishes a
/// live token from a replayed one via `consumed_at`.
pub(super) fn refresh_token_with_family_by_hash(
    conn: &mut SqliteConnection,
    token_hash: &str,
) -> Result<Option<(RefreshToken, RefreshTokenFamily)>, GatekeeperError> {
    refresh_tokens::table
        .inner_join(refresh_token_families::table)
        .filter(refresh_tokens::token_hash.eq(token_hash))
        .select((RefreshToken::as_select(), RefreshTokenFamily::as_select()))
        .first(conn)
        .optional()
        .map_err(|e| GatekeeperError::infrastructure("refresh_token_with_family_by_hash failed", e))
}

/// Stamp the live token `token_hash` consumed at `now`, returning `true` iff a
/// live (un-consumed) row was actually transitioned. The `consumed_at IS NULL`
/// guard is the whole atomicity of the consume: a concurrent redeemer of the
/// same live token loses the affected-row count and gets `false`. The
/// three-state consume decision (`Consumed` / `Replayed` / `NotFound`) is
/// assembled from this plus [`refresh_token_exists`] in
/// [`rotate_refresh_token`](crate::domain::refresh_token::rotate_refresh_token), which
/// runs both inside one domain transaction so the pair reads a single snapshot.
pub(super) fn stamp_refresh_token_consumed_if_live(
    conn: &mut SqliteConnection,
    token_hash: &str,
    now: DateTime<Utc>,
) -> Result<bool, GatekeeperError> {
    let affected = diesel::update(
        refresh_tokens::table
            .find(token_hash)
            .filter(refresh_tokens::consumed_at.is_null()),
    )
    .set(refresh_tokens::consumed_at.eq(now))
    .execute(conn)
    .map_err(|e| {
        GatekeeperError::infrastructure("stamp_refresh_token_consumed_if_live failed", e)
    })?;
    Ok(affected == 1)
}

/// Whether any token row (live or consumed) bears `token_hash` — the existence
/// probe that tells a replay from a miss after
/// [`stamp_refresh_token_consumed_if_live`] reported no live row.
pub(super) fn refresh_token_exists(
    conn: &mut SqliteConnection,
    token_hash: &str,
) -> Result<bool, GatekeeperError> {
    diesel::select(diesel::dsl::exists(refresh_tokens::table.find(token_hash)))
        .get_result(conn)
        .map_err(|e| GatekeeperError::infrastructure("refresh_token_exists failed", e))
}

/// End a token family by pulling its `expires_at` back to `now`, and
/// stamp its still-live token consumed at the same instant so no row in
/// a dead family looks live. Used by reuse detection. Rows are kept (not
/// deleted) so the lineage stays auditable and replayed tokens still
/// resolve to their dead family. The `consumed_at IS NULL` guard keeps
/// genuine consumption stamps intact.
pub(super) fn expire_refresh_token_family(
    conn: &mut SqliteConnection,
    family_id: &str,
    now: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    conn.transaction(|conn| {
        diesel::update(refresh_token_families::table.find(family_id))
            .set(refresh_token_families::expires_at.eq(now))
            .execute(conn)?;
        diesel::update(
            refresh_tokens::table
                .filter(refresh_tokens::family_id.eq(family_id))
                .filter(refresh_tokens::consumed_at.is_null()),
        )
        .set(refresh_tokens::consumed_at.eq(now))
        .execute(conn)?;
        Ok(())
    })
    .map_err(|e: diesel::result::Error| {
        GatekeeperError::infrastructure("expire_refresh_token_family failed", e)
    })
}

/// End every refresh-token family issued to a client, with the same
/// expire-and-stamp semantics as [`expire_refresh_token_family`] — used when
/// the Owner revokes a grant, so standing consent and standing credentials die
/// together.
pub(super) fn expire_refresh_token_families_for_client(
    conn: &mut SqliteConnection,
    client_id: &str,
    now: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    conn.transaction(|conn| {
        diesel::update(
            refresh_tokens::table
                .filter(refresh_tokens::consumed_at.is_null())
                .filter(
                    refresh_tokens::family_id.eq_any(
                        refresh_token_families::table
                            .filter(refresh_token_families::client_id.eq(client_id))
                            .select(refresh_token_families::family_id),
                    ),
                ),
        )
        .set(refresh_tokens::consumed_at.eq(now))
        .execute(conn)?;
        diesel::update(
            refresh_token_families::table.filter(refresh_token_families::client_id.eq(client_id)),
        )
        .set(refresh_token_families::expires_at.eq(now))
        .execute(conn)?;
        Ok(())
    })
    .map_err(|e: diesel::result::Error| {
        GatekeeperError::infrastructure("expire_refresh_token_families_for_client failed", e)
    })
}

/// End every refresh-token family minted from a given authorization code
/// (identified by the code's hash), with the same expire-and-stamp
/// semantics as [`expire_refresh_token_family`]. Used by authorization-code
/// reuse detection (RFC 6749 §4.1.2): a detectably replayed code revokes the
/// refresh lineage its first redemption produced. A code that never minted a
/// family (no `offline_access`, or never existed) matches no row and the call
/// is a no-op.
pub(super) fn expire_refresh_token_families_for_authorization_code(
    conn: &mut SqliteConnection,
    authorization_code_hash: &str,
    now: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    conn.transaction(|conn| {
        diesel::update(
            refresh_tokens::table
                .filter(refresh_tokens::consumed_at.is_null())
                .filter(
                    refresh_tokens::family_id.eq_any(
                        refresh_token_families::table
                            .filter(
                                refresh_token_families::authorization_code_hash
                                    .eq(authorization_code_hash),
                            )
                            .select(refresh_token_families::family_id),
                    ),
                ),
        )
        .set(refresh_tokens::consumed_at.eq(now))
        .execute(conn)?;
        diesel::update(
            refresh_token_families::table.filter(
                refresh_token_families::authorization_code_hash.eq(authorization_code_hash),
            ),
        )
        .set(refresh_token_families::expires_at.eq(now))
        .execute(conn)?;
        Ok(())
    })
    .map_err(|e: diesel::result::Error| {
        GatekeeperError::infrastructure(
            "expire_refresh_token_families_for_authorization_code failed",
            e,
        )
    })
}

/// Delete every refresh-token family whose absolute deadline fell before
/// `cutoff`, along with the `refresh_tokens` rows descended from them, and
/// return how many **families** were removed. Children first, so the delete
/// passes under `PRAGMA foreign_keys = ON`.
///
/// The one place lineage is destroyed rather than expired in place — the
/// counterpart to [`expire_refresh_token_family`], which keeps it readable.
/// `cutoff` is the *retention* cutoff, not `now`; the window is the caller's
/// (`domain::retention::purge_expired`).
pub(super) fn delete_refresh_token_families_expired_before(
    conn: &mut SqliteConnection,
    cutoff: DateTime<Utc>,
) -> Result<usize, GatekeeperError> {
    conn.transaction(|conn| {
        diesel::delete(
            refresh_tokens::table.filter(
                refresh_tokens::family_id.eq_any(
                    refresh_token_families::table
                        .filter(refresh_token_families::expires_at.lt(cutoff))
                        .select(refresh_token_families::family_id),
                ),
            ),
        )
        .execute(conn)?;
        diesel::delete(
            refresh_token_families::table.filter(refresh_token_families::expires_at.lt(cutoff)),
        )
        .execute(conn)
    })
    .map_err(|e: diesel::result::Error| {
        GatekeeperError::infrastructure("delete_refresh_token_families_expired_before failed", e)
    })
}

#[cfg(test)]
mod tests;
