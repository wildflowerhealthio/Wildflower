//! [`AuthorizationRequestsTx`] — the `authorization_requests` table: the
//! requests the Owner decides, from start to their retention cutoff.

use chrono::{DateTime, Utc};

use crate::domain::authorization_request::{
    AuthorizationRequest, RequestTransition, TransitionRefused,
};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::pending_consent::NewestPendingConsent;

/// The authorization requests the Owner decides. Every method is one primitive on the caller's
/// [`GrantStore`](super::GrantStore) scope: a single statement, or a few
/// that land together within that scope.
pub trait AuthorizationRequestsTx {
    /// Load an authorization request by its primary id (the `device_code` for
    /// device-flow, otherwise an internal UUID), or `None` when absent.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to an [`AuthorizationRequest`].
    fn authorization_request_by_id(
        &mut self,
        id: &str,
    ) -> Result<Option<AuthorizationRequest>, AuthorizationServerError>;

    /// Load *any* authorization request bearing the human-typed `user_code`,
    /// regardless of status, or `None` when absent. Callers that need a live
    /// request must use [`Self::pending_authorization_request_by_user_code`].
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to an [`AuthorizationRequest`].
    fn authorization_request_by_user_code(
        &mut self,
        user_code: &str,
    ) -> Result<Option<AuthorizationRequest>, AuthorizationServerError>;

    /// Load the *pending* authorization request for `user_code` (the
    /// `status = 'pending'` filter stops a stale terminal row from shadowing a
    /// live one), or `None` when none is pending.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to an [`AuthorizationRequest`].
    fn pending_authorization_request_by_user_code(
        &mut self,
        user_code: &str,
    ) -> Result<Option<AuthorizationRequest>, AuthorizationServerError>;

    /// The newest request still awaiting the Owner at `now` — pending,
    /// unexpired, and (for a code request) past its browser's limited page —
    /// as the host notifies and opens it, or `None` when there is none.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the read fails or the
    /// row is malformed.
    fn newest_pending_consent(
        &mut self,
        now: DateTime<Utc>,
    ) -> Result<Option<NewestPendingConsent>, AuthorizationServerError>;

    /// Persist a freshly started request.
    ///
    /// Bulk reclamation of expired rows belongs to
    /// `domain::retention::purge_expired`,
    /// not here — an insert leaves unrelated expired rows alone so the retention
    /// window is the only thing that decides when they go. Implementations may
    /// still clear a pending row holding this request's `user_code` that had
    /// expired by the time this request started, since that row occupies the
    /// partial unique index this insert would otherwise collide with.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the insert fails (for example a
    /// unique-constraint violation on the id, or a collision with a *live*
    /// pending request holding the same `user_code`).
    fn insert_authorization_request(
        &mut self,
        request: &AuthorizationRequest,
    ) -> Result<(), AuthorizationServerError>;

    /// Write `transition`'s request over its row, but only where the row is
    /// still in the phase the request was read in (its status, and a code
    /// request's session-shortfall acknowledgement), returning whether it
    /// landed. A row another transition moved on since the read is left as
    /// it is.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails.
    fn replace_authorization_request(
        &mut self,
        transition: &RequestTransition,
    ) -> Result<bool, AuthorizationServerError>;

    /// Delete every authorization request whose `expires_at` fell before
    /// `cutoff`, returning how many rows went.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the delete fails.
    fn delete_authorization_requests_expired_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, AuthorizationServerError>;
}

/// Write the outcome of a transition in `tx`: the transitioned request when
/// the transition applied and its row is still in the phase it was read in.
/// Returns whether it was written; a refused transition writes nothing.
///
/// # Errors
///
/// [`AuthorizationServerError::Infrastructure`] if the update fails.
pub fn write_transition(
    tx: &mut (impl AuthorizationRequestsTx + ?Sized),
    transition: Result<RequestTransition, TransitionRefused>,
) -> Result<bool, AuthorizationServerError> {
    match transition {
        Ok(transition) => tx.replace_authorization_request(&transition),
        Err(_) => Ok(false),
    }
}
