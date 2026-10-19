//! The shared consent tail: deny a request still pending.

use chrono::{DateTime, Utc};

use crate::domain::authorization_request::AuthorizationRequest;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::grant_store::{write_transition, AuthorizationRequestsTx};

/// Deny `request`, as read, at `now`, in the caller's write scope `tx` — the
/// shared tail of every deny path (an explicit deny, and an approval that
/// grants nothing).
///
/// The deny lands only on a request still pending: when another surface
/// decided it first (or it expired) since it was read, nothing changes and the
/// flow's own not-found error (`make_not_found`) is returned, as an approval
/// that loses the same race does.
pub(super) fn deny_pending_request(
    tx: &mut impl AuthorizationRequestsTx,
    request: &AuthorizationRequest,
    now: DateTime<Utc>,
    make_not_found: impl FnOnce() -> AuthorizationServerError,
) -> Result<(), AuthorizationServerError> {
    if write_transition(tx, request.deny(now))? {
        Ok(())
    } else {
        Err(make_not_found())
    }
}
