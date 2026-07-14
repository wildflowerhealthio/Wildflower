//! Signing-key actions over the [`GatekeeperStore`] port.

use crate::domain::error::GatekeeperError;
use crate::domain::signing_key::SigningKey;
use crate::domain::GatekeeperStore;

/// Every signing key (active first) — the JWKS surface and the verify path.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn all_signing_keys(
    store: &impl GatekeeperStore,
) -> Result<Vec<SigningKey>, GatekeeperError> {
    store.all_signing_keys()
}

/// The active signing key, or `None` — the token-mint path.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn active_signing_key(
    store: &impl GatekeeperStore,
) -> Result<Option<SigningKey>, GatekeeperError> {
    store.active_signing_key()
}

/// Whether an active signing key exists — the `/authorize` up-front 503 probe.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn has_active_signing_key(
    store: &impl GatekeeperStore,
) -> Result<bool, GatekeeperError> {
    store.has_active_signing_key()
}
