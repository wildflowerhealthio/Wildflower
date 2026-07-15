//! Authorization-code actions over the [`GatekeeperStore`] port.

use crate::domain::authorization_code::AuthorizationCode;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::GatekeeperStore;

/// Atomically read-and-consume an authorization code (single-use).
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn redeem_authorization_code(
    store: &impl GatekeeperStore,
    code: &str,
) -> Result<Option<AuthorizationCode>, GatekeeperError> {
    store.redeem_authorization_code(code)
}

/// The code issued for a `request_id` — the polling endpoint's `Approved` arm.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn authorization_code_by_request_id(
    store: &impl GatekeeperStore,
    request_id: &str,
) -> Result<Option<AuthorizationCode>, GatekeeperError> {
    store.authorization_code_by_request_id(request_id)
}

/// Persist a freshly-minted authorization code.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn issue_authorization_code(
    store: &impl GatekeeperStore,
    code: &AuthorizationCode,
) -> Result<(), GatekeeperError> {
    store.issue_authorization_code(code)
}
