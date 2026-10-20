//! [`AuthorizationRequestsTx`] — the requests the Owner decides, from start to
//! their retention cutoff: code requests, and the device requests and browser
//! pairings a poll claims. A read or
//! write within one flow takes that flow's struct; the reads that cross flows
//! answer with an [`AuthorizationRequest`].

use chrono::{DateTime, Utc};

use crate::domain::authorization_request::code::CodeRequest;
use crate::domain::authorization_request::device::DeviceRequest;
use crate::domain::authorization_request::pairing::PairingRequest;
use crate::domain::authorization_request::polled::PolledRequest;
use crate::domain::authorization_request::AuthorizationRequest;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::consent_key::ConsentKey;
use crate::domain::owner_prompt::OwnerPrompt;

/// The authorization requests the Owner decides. Every method is one primitive on the caller's
/// [`GrantStore`](super::GrantStore) scope: a single statement, or a few
/// that land together within that scope.
///
/// Every read fails with [`AuthorizationServerError::Infrastructure`] when
/// the read fails or a returned row is malformed (a column its flow requires
/// is missing, or its approval disagrees with its status), rather than
/// reading as absent.
///
/// The `replace_*` writes are each flow's guarded replace: write `changed`
/// over the row of `read`'s id, but only while that row still has `read`'s
/// status, returning whether it landed. Of two transitions read from one row,
/// the first to land wins and the other answers `false`. The write is the
/// whole row, so a transition read before a poll stamp landed writes the
/// stamp's `last_polled_at` back as it read it.
pub trait AuthorizationRequestsTx {
    /// Load the request of any flow whose key is `id` (a `device_code`, a
    /// pairing code, or a code request's UUID), or `None` when absent.
    ///
    /// # Errors
    ///
    /// See the [trait](Self).
    fn authorization_request_by_id(
        &mut self,
        id: &str,
    ) -> Result<Option<AuthorizationRequest>, AuthorizationServerError>;

    /// Load the code request `id`, in whatever state, or `None` when there is
    /// no code request with that id.
    ///
    /// # Errors
    ///
    /// See the [trait](Self).
    fn code_request_by_id(
        &mut self,
        id: &str,
    ) -> Result<Option<CodeRequest>, AuthorizationServerError>;

    /// Load the device request keyed by `device_code`, in whatever state, or
    /// `None` when there is no device request with that key.
    ///
    /// # Errors
    ///
    /// See the [trait](Self).
    fn device_request_by_id(
        &mut self,
        device_code: &str,
    ) -> Result<Option<DeviceRequest>, AuthorizationServerError>;

    /// Load the browser pairing keyed by `pairing_code`, in whatever state,
    /// or `None` when there is no pairing with that key.
    ///
    /// # Errors
    ///
    /// See the [trait](Self).
    fn pairing_request_by_id(
        &mut self,
        pairing_code: &str,
    ) -> Result<Option<PairingRequest>, AuthorizationServerError>;

    /// Load *any* device request or pairing bearing the human-typed
    /// `user_code`, regardless of status, or `None` when absent. Callers that
    /// need a live request must use
    /// [`Self::pending_polled_request_by_user_code`].
    ///
    /// # Errors
    ///
    /// See the [trait](Self).
    fn polled_request_by_user_code(
        &mut self,
        user_code: &str,
    ) -> Result<Option<PolledRequest>, AuthorizationServerError>;

    /// Load the *pending* device request or pairing for `user_code` (the
    /// status filter stops a stale terminal row from shadowing a live one),
    /// or `None` when none is pending.
    ///
    /// # Errors
    ///
    /// See the [trait](Self).
    fn pending_polled_request_by_user_code(
        &mut self,
        user_code: &str,
    ) -> Result<Option<PolledRequest>, AuthorizationServerError>;

    /// The newest request waiting for the Owner at `now` — pending and
    /// unexpired, so not a code request still on its browser's limited page —
    /// as the host notifies and opens it, or `None` when there is none.
    ///
    /// # Errors
    ///
    /// See the [trait](Self).
    fn owner_prompt(
        &mut self,
        now: DateTime<Utc>,
    ) -> Result<Option<OwnerPrompt>, AuthorizationServerError>;

    /// Whether the request `consent_key` names is still undecided at `now`
    /// ([`AuthorizationRequest::is_undecided_at`]: a code request still on
    /// its browser's limited page included), and its client not disabled
    /// (the rule on [`OwnerPrompt`]). A request that isn't there, or is
    /// decided or expired, isn't.
    ///
    /// # Errors
    ///
    /// See the [trait](Self).
    fn is_awaiting_owner(
        &mut self,
        consent_key: &ConsentKey,
        now: DateTime<Utc>,
    ) -> Result<bool, AuthorizationServerError>;

    /// Persist a freshly started code request.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the insert fails (for
    /// example a unique-constraint violation on the id).
    fn insert_code_request(
        &mut self,
        request: &CodeRequest,
    ) -> Result<(), AuthorizationServerError>;

    /// Persist a freshly started device request.
    ///
    /// Bulk reclamation of expired rows belongs to
    /// `domain::retention::purge_expired`, not here — an insert leaves
    /// unrelated expired rows alone so the retention window is the only thing
    /// that decides when they go. Implementations may still clear a pending
    /// row holding this request's `user_code` that had expired by the time
    /// this request started, since that row occupies the partial unique
    /// index this insert would otherwise collide with.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the insert fails (for
    /// example a unique-constraint violation on the id, or a collision with
    /// a *live* pending request holding the same `user_code`).
    fn insert_device_request(
        &mut self,
        request: &DeviceRequest,
    ) -> Result<(), AuthorizationServerError>;

    /// Persist a freshly started browser pairing, as
    /// [`insert_device_request`](Self::insert_device_request) does a device
    /// request.
    ///
    /// # Errors
    ///
    /// As [`insert_device_request`](Self::insert_device_request).
    fn insert_pairing_request(
        &mut self,
        request: &PairingRequest,
    ) -> Result<(), AuthorizationServerError>;

    /// The code flow's guarded replace (see the [trait](Self)).
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails, or
    /// `changed` has another id than `read`.
    fn replace_code_request(
        &mut self,
        read: &CodeRequest,
        changed: &CodeRequest,
    ) -> Result<bool, AuthorizationServerError>;

    /// The device flow's guarded replace (see the [trait](Self)).
    ///
    /// # Errors
    ///
    /// As [`replace_code_request`](Self::replace_code_request).
    fn replace_device_request(
        &mut self,
        read: &DeviceRequest,
        changed: &DeviceRequest,
    ) -> Result<bool, AuthorizationServerError>;

    /// A browser pairing's guarded replace (see the [trait](Self)).
    ///
    /// # Errors
    ///
    /// As [`replace_code_request`](Self::replace_code_request).
    fn replace_pairing_request(
        &mut self,
        read: &PairingRequest,
        changed: &PairingRequest,
    ) -> Result<bool, AuthorizationServerError>;

    /// Delete every code request whose `expires_at` fell before `cutoff`,
    /// returning how many went.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the delete fails.
    fn delete_code_requests_expired_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, AuthorizationServerError>;

    /// Delete every device request and browser pairing whose `expires_at`
    /// fell before `cutoff`, returning how many went.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the delete fails.
    fn delete_polled_requests_expired_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, AuthorizationServerError>;
}
