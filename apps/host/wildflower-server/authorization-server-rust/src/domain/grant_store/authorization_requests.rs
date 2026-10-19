//! [`AuthorizationRequestsTx`] — the `authorization_requests` table: the
//! requests the Owner decides, from start to their retention cutoff.

use chrono::{DateTime, Utc};

use crate::domain::authorization_request::AuthorizationRequest;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::pending_consent::NewestPendingConsent;

/// The authorization requests the Owner decides. Every method is one statement on the caller's
/// [`GrantStore`](super::GrantStore) scope.
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

    /// The newest pending, non-expired authorization request across both grant
    /// flows — the one the host notifies and opens — or `None` when none
    /// exists. A device row is admitted only with a `user_code` (its lookup key
    /// on the consent surface); a code row is keyed by `id`.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the read fails or the selected
    /// columns can't be decoded.
    fn newest_pending_consent(
        &mut self,
    ) -> Result<Option<NewestPendingConsent>, AuthorizationServerError>;

    /// Persist a freshly-constructed `AuthorizationRequest`.
    ///
    /// Bulk reclamation of expired rows belongs to
    /// [`domain::retention::purge_expired`](crate::domain::retention::purge_expired),
    /// not here — an insert leaves unrelated expired rows alone so the retention
    /// window is the only thing that decides when they go. Implementations may
    /// still clear an *already-expired* `status = 'pending'` row holding this
    /// request's `user_code`, since that row occupies the partial unique index
    /// this insert would otherwise collide with.
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

    /// Mark a *pending* `id` approved with `granted_scopes`, an optional patient
    /// context, and an optional adjusted `device_name`, returning `true` iff a
    /// pending row was actually transitioned (the `status = 'pending'` guard
    /// makes a terminal row unflippable, and the affected-row count exposes a
    /// concurrent transition as `false`).
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails.
    fn approve_authorization_request(
        &mut self,
        id: &str,
        granted_scopes: &[String],
        patient: Option<&str>,
        device_name: Option<&str>,
    ) -> Result<bool, AuthorizationServerError>;

    /// Mark a *pending* `id` denied, returning `true` iff a pending row was
    /// transitioned. A request already in a terminal state is left as it is,
    /// so the first decision on a request wins.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails.
    fn deny_authorization_request(&mut self, id: &str) -> Result<bool, AuthorizationServerError>;

    /// Raise a *pending* `id` for the Owner: it no longer counts as
    /// decidable in the browser that made it, so the host notifies for it.
    /// Returns `true` iff a pending row was found. Decides nothing.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails.
    fn raise_authorization_request_for_owner(
        &mut self,
        id: &str,
    ) -> Result<bool, AuthorizationServerError>;

    /// Record that the browser that made the *pending* code-flow request `id`
    /// goes on although its browser session falls short of what it asks for,
    /// and move the request's `expires_at` to `expires_at`. Returns `true` iff
    /// a pending row still waiting on that acknowledgement was transitioned.
    /// Decides nothing.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails.
    fn acknowledge_session_shortfall(
        &mut self,
        id: &str,
        expires_at: DateTime<Utc>,
    ) -> Result<bool, AuthorizationServerError>;

    /// Deny the *pending* code-flow request `id` only while it still waits on
    /// its browser's limited page (its session shortfall unacknowledged).
    /// Returns `true` iff such a row was transitioned, so a Cancel and a
    /// concurrent Continue race to one winner.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails.
    fn deny_unacknowledged_authorization_request(
        &mut self,
        id: &str,
    ) -> Result<bool, AuthorizationServerError>;

    /// Atomically claim an `approved` request for single-use redemption
    /// (`approved` → `expired` only if still `approved`), returning `true` iff
    /// this call won the race (RFC 8628 §3.4).
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails.
    fn consume_approved_authorization_request(
        &mut self,
        id: &str,
    ) -> Result<bool, AuthorizationServerError>;

    /// Stamp `last_polled_at` so the next device-flow poll can be slow-down
    /// rate-limited.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails.
    fn record_device_poll(
        &mut self,
        id: &str,
        polled_at: DateTime<Utc>,
    ) -> Result<(), AuthorizationServerError>;

    /// Stamp a *pending* browser pairing `id`'s `last_polled_at` and record the
    /// `browser_name` its page now gives, so the next poll can be slow-down
    /// rate-limited and the Owner sees the browser's latest name. A request no
    /// longer pending is left as it is.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails.
    fn record_browser_pairing_poll(
        &mut self,
        id: &str,
        polled_at: DateTime<Utc>,
        browser_name: &str,
    ) -> Result<(), AuthorizationServerError>;

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
