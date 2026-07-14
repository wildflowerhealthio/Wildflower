//! Refresh-token-family actions over the [`GatekeeperStore`] port.

use chrono::{DateTime, Utc};

use crate::domain::error::GatekeeperError;
use crate::domain::refresh_token::{RefreshToken, RefreshTokenConsumeOutcome, RefreshTokenFamily};
use crate::domain::GatekeeperStore;

/// Persist a new refresh-token family plus its first token.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn insert_refresh_token_family(
    store: &impl GatekeeperStore,
    family: &RefreshTokenFamily,
    first_token: &RefreshToken,
) -> Result<(), GatekeeperError> {
    store.insert_refresh_token_family(family, first_token)
}

/// Resolve a presented token hash to its row plus owning family.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn refresh_token_with_family_by_hash(
    store: &impl GatekeeperStore,
    token_hash: &str,
) -> Result<Option<(RefreshToken, RefreshTokenFamily)>, GatekeeperError> {
    store.refresh_token_with_family_by_hash(token_hash)
}

/// Atomically rotate a refresh token (consume + insert successor).
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn rotate_refresh_token(
    store: &impl GatekeeperStore,
    presented_hash: &str,
    successor: &RefreshToken,
    now: DateTime<Utc>,
) -> Result<RefreshTokenConsumeOutcome, GatekeeperError> {
    store.rotate_refresh_token(presented_hash, successor, now)
}

/// End a single refresh-token family (reuse detection).
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn expire_refresh_token_family(
    store: &impl GatekeeperStore,
    family_id: &str,
    now: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    store.expire_refresh_token_family(family_id, now)
}

/// End every family minted from an authorization code (code-reuse detection).
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn expire_refresh_token_families_for_authorization_code(
    store: &impl GatekeeperStore,
    authorization_code_hash: &str,
    now: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    store.expire_refresh_token_families_for_authorization_code(authorization_code_hash, now)
}
