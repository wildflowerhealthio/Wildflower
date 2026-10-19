//! The shared consent tail: deny a request still pending.

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::grant_store::AuthorizationRequestsTx;

/// Mark request `request_id` denied in the caller's write scope `tx` — the
/// shared tail of every deny path (an explicit deny, and an approval that
/// grants nothing).
///
/// The deny applies only to a still-pending request: when another surface
/// decided it first (or it expired) between the caller's load and this write,
/// nothing changes and the flow's own not-found error (`make_not_found`) is
/// returned, as an approval that loses the same race does.
pub(super) fn deny_pending_request(
    tx: &mut impl AuthorizationRequestsTx,
    request_id: &str,
    make_not_found: impl FnOnce() -> AuthorizationServerError,
) -> Result<(), AuthorizationServerError> {
    if tx.deny_authorization_request(request_id)? {
        Ok(())
    } else {
        Err(make_not_found())
    }
}
