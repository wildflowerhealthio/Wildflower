use chrono::{DateTime, Utc};
use url::Url;

use crate::domain::authorization_code::IssuedAuthorizationCode;
use crate::domain::authorization_request::AuthorizationRequest;
use crate::domain::client::Client;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::grant::{AuthorizationCodeGrant, DeviceGrant, Grant};
use crate::domain::launch_context::LaunchContext;
use crate::domain::pending_consent::PendingConsentHead;
use crate::domain::refresh_token::{RefreshToken, RefreshTokenFamily};
use crate::domain::signing_key::SigningKey;

/// The primitive persistence contract, scoped to one connection. Every method
/// is a single logical statement over the domain types — absence as `Option`,
/// an affected-row outcome as `bool` — raising only
/// [`AuthorizationServerError::Infrastructure`]. `&mut self` (rather than `&self`) is what
/// lets [`GrantStore`](super::GrantStore) hand a batch of these out inside one transaction; a
/// domain action composes several into an atomic operation without any
/// per-operation transaction method on the store.
///
/// The `SQLite` adapter's `SqliteGrantTx` implements this over a
/// checked-out diesel connection; the in-memory `FakeGrantTx` implements it
/// over the fake's maps.
pub trait GrantTx {
    // ----- clients -------------------------------------------------------

    /// Look up a registered client by its `client_id`, or `None` when no client
    /// has this id.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to a [`Client`].
    fn client_by_id(&mut self, client_id: &str) -> Result<Option<Client>, AuthorizationServerError>;

    /// Insert a client, or update its policy fields if one with the same
    /// `client_id` already exists (`ON CONFLICT … DO UPDATE`) — used by
    /// first-boot seeding so a seeded client's definition always matches the
    /// code, preserving `registered_at` and `disabled_at`.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the upsert fails.
    fn upsert_client(&mut self, client: &Client) -> Result<(), AuthorizationServerError>;

    /// Every registered client, ordered by `client_id` — the Owner's "Trusted
    /// apps" list. Disabled clients are included (their `disabled_at` is set).
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the read fails or any returned row
    /// cannot be mapped to a [`Client`].
    fn list_clients(&mut self) -> Result<Vec<Client>, AuthorizationServerError>;

    /// Set (`Some`) or clear (`None`) a client's `disabled_at`, touching no other
    /// column. Returns whether a row with this `client_id` existed. A disabled
    /// client is refused at `/oauth/authorize` and `/oauth/token`; clearing the
    /// stamp re-enables it with its registration intact.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails.
    fn set_client_disabled(
        &mut self,
        client_id: &str,
        disabled_at: Option<DateTime<Utc>>,
    ) -> Result<bool, AuthorizationServerError>;

    // ----- signing keys --------------------------------------------------

    /// Load every signing key, active keys first then by `kid`.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the read fails or any returned row
    /// cannot be mapped to a [`SigningKey`].
    fn all_signing_keys(&mut self) -> Result<Vec<SigningKey>, AuthorizationServerError>;

    /// Load the active signing key, or `None` when none is active.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to a [`SigningKey`].
    fn active_signing_key(&mut self) -> Result<Option<SigningKey>, AuthorizationServerError>;

    /// Whether an active signing key exists, without loading its (private) key
    /// material — a cheap presence probe.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the query fails.
    fn has_active_signing_key(&mut self) -> Result<bool, AuthorizationServerError>;

    /// Persist a signing key.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the insert fails (for example a
    /// unique-constraint violation on the `kid`).
    fn insert_signing_key(&mut self, key: &SigningKey) -> Result<(), AuthorizationServerError>;

    // ----- authorization requests ----------------------------------------

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

    /// The oldest pending, non-expired authorization request across both grant
    /// flows — the FIFO head the host popup surfaces — or `None` when none
    /// exists. A device row is admitted only with a `user_code` (its lookup key
    /// on the consent surface); a code row is keyed by `id`.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the read fails or the selected
    /// columns can't be decoded.
    fn oldest_pending_consent_head(
        &mut self,
    ) -> Result<Option<PendingConsentHead>, AuthorizationServerError>;

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

    /// Atomically claim an `approved` request for single-use redemption
    /// (`approved` → `expired` only if still `approved`), returning `true` iff
    /// this call won the race (RFC 8628 §3.4).
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails.
    fn consume_approved_authorization_request(&mut self, id: &str)
        -> Result<bool, AuthorizationServerError>;

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

    // ----- authorization codes -------------------------------------------

    /// Atomically read-and-delete the authorization `code` (`DELETE …
    /// RETURNING`), returning the row exactly once or `None` to any racer —
    /// RFC 6749 §10.5 single-use.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the delete-returning query fails or
    /// a returned row cannot be mapped to an [`IssuedAuthorizationCode`].
    fn redeem_authorization_code(
        &mut self,
        code: &str,
    ) -> Result<Option<IssuedAuthorizationCode>, AuthorizationServerError>;

    /// Look up the code issued for a given `request_id`, or `None` when absent —
    /// used by the authorize-status poll to build the final redirect URL.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to an [`IssuedAuthorizationCode`].
    fn authorization_code_by_request_id(
        &mut self,
        request_id: &str,
    ) -> Result<Option<IssuedAuthorizationCode>, AuthorizationServerError>;

    /// Persist a freshly-minted authorization code.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the insert fails (for example a
    /// unique-constraint violation on the code).
    fn issue_authorization_code(
        &mut self,
        code: &IssuedAuthorizationCode,
    ) -> Result<(), AuthorizationServerError>;

    // ----- launch contexts ------------------------------------------------

    /// Persist a freshly minted SMART App Launch context.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the insert fails (including a
    /// duplicate `nonce`).
    fn insert_launch_context(&mut self, context: &LaunchContext) -> Result<(), AuthorizationServerError>;

    /// Stamp the launch `nonce` consumed at `now` and return it, iff it was
    /// minted for `client_id` or for any client, is unconsumed, and is
    /// unexpired at `now`; otherwise `None` and nothing changes. The check and
    /// the stamp are one statement, so of two concurrent consumes of one nonce
    /// exactly one gets the context.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails or the returned
    /// row cannot be mapped to a [`LaunchContext`].
    fn consume_launch_context(
        &mut self,
        nonce: &str,
        client_id: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<LaunchContext>, AuthorizationServerError>;

    /// Delete every launch context that expired at or before `now`, returning
    /// how many went — the opportunistic prune a mint runs.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the delete fails.
    fn delete_launch_contexts_expired_by(
        &mut self,
        now: DateTime<Utc>,
    ) -> Result<usize, AuthorizationServerError>;

    // ----- retention ------------------------------------------------------
    //
    // The three reclaiming deletes, each taking an already-computed *cutoff*
    // rather than `now` — the windows belong to `domain::retention`, which
    // composes these in one transaction, not to a primitive.

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

    /// Delete every authorization code whose `expires_at` fell before `cutoff`,
    /// returning how many rows went. Redemption already deletes a code as it is
    /// used, so this reaps only abandoned ones.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the delete fails.
    fn delete_authorization_codes_expired_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, AuthorizationServerError>;

    /// Delete every refresh-token family whose absolute deadline fell before
    /// `cutoff`, together with the tokens descended from it, returning how many
    /// **families** went — the counterpart to
    /// [`Self::expire_refresh_token_family`], which keeps the lineage readable.
    /// Self-contained: children before parents in its own (possibly nested)
    /// transaction, so the foreign key holds either way.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the transaction or either delete
    /// fails.
    fn delete_refresh_token_families_expired_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, AuthorizationServerError>;

    // ----- refresh-token families ----------------------------------------

    /// Persist a new refresh-token family **row only** — a single-table insert.
    /// Pairing it with its first token (so a family never persists tokenless) is
    /// the [`insert_refresh_token_family`](crate::domain::refresh_token::insert_refresh_token_family)
    /// action's job, sequencing this then [`Self::insert_refresh_token`].
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the insert fails.
    fn insert_refresh_token_family_row(
        &mut self,
        family: &RefreshTokenFamily,
    ) -> Result<(), AuthorizationServerError>;

    /// Persist the successor token in an existing family's rotation.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the insert fails (for example a
    /// unique-constraint violation on the token hash, or a foreign-key violation
    /// for an unknown family).
    fn insert_refresh_token(&mut self, token: &RefreshToken) -> Result<(), AuthorizationServerError>;

    /// Resolve a presented token hash to its row plus the owning family in one
    /// JOIN (consumed tokens resolve too — the caller distinguishes live from
    /// replayed via `consumed_at`), or `None` when absent.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the join fails or a returned row
    /// cannot be mapped to a [`RefreshToken`]/[`RefreshTokenFamily`] pair.
    fn refresh_token_with_family_by_hash(
        &mut self,
        token_hash: &str,
    ) -> Result<Option<(RefreshToken, RefreshTokenFamily)>, AuthorizationServerError>;

    /// Stamp the live token `token_hash` consumed at `now`, returning `true` iff
    /// a live (un-consumed) row was actually transitioned — the guarded half of
    /// a refresh-token consume. The `consumed_at IS NULL` guard makes a replay a
    /// `false`, and pairing this with [`Self::refresh_token_exists`] inside one
    /// transaction is how
    /// [`rotate_refresh_token`](crate::domain::refresh_token::rotate_refresh_token)
    /// resolves the three-state consume without a dedicated store method.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails.
    fn stamp_refresh_token_consumed_if_live(
        &mut self,
        token_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<bool, AuthorizationServerError>;

    /// Whether any token row (live or consumed) bears `token_hash` — the
    /// existence probe that tells a replay (`true`) from a miss (`false`) after
    /// [`Self::stamp_refresh_token_consumed_if_live`] reported no live row.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the query fails.
    fn refresh_token_exists(&mut self, token_hash: &str) -> Result<bool, AuthorizationServerError>;

    /// End a token family (pull its `expires_at` back to `now` and stamp its
    /// still-live token consumed at the same instant). Rows are kept, not
    /// deleted, so the lineage stays auditable. Self-contained: the two updates
    /// run in this method's own (possibly nested) transaction, so it is atomic
    /// whether invoked standalone or composed inside a larger domain
    /// transaction.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the transaction or either update
    /// fails.
    fn expire_refresh_token_family(
        &mut self,
        family_id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), AuthorizationServerError>;

    /// End every refresh-token family issued to a client, with the same
    /// expire-and-stamp semantics as [`Self::expire_refresh_token_family`] — the
    /// standing-credential half of a grant revoke.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the transaction or either update
    /// fails.
    fn expire_refresh_token_families_for_client(
        &mut self,
        client_id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), AuthorizationServerError>;

    /// End every refresh-token family minted from a given authorization code
    /// (by the code's hash), with the same expire-and-stamp semantics as
    /// [`Self::expire_refresh_token_family`] — authorization-code reuse detection
    /// (RFC 6749 §4.1.2). A code that never minted a family is a no-op.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the transaction or either update
    /// fails.
    fn expire_refresh_token_families_for_authorization_code(
        &mut self,
        authorization_code_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<(), AuthorizationServerError>;

    // ----- grants --------------------------------------------------------

    /// All grants in `granted_at` order — the cross-kind read off the `grants`
    /// view backing the launcher's access index.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the view read fails or a returned
    /// row cannot be mapped to a [`Grant`].
    fn all_grants(&mut self) -> Result<Vec<Grant>, AuthorizationServerError>;

    /// Load a single grant by primary id (a cross-kind read off the `grants`
    /// view; ids are UUIDs unique across both concrete tables), or `None` when
    /// absent.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the view read fails or the returned
    /// row cannot be mapped to a [`Grant`].
    fn grant_by_id(&mut self, id: &str) -> Result<Option<Grant>, AuthorizationServerError>;

    /// Find the standing authorization-code grant for a (`client_id`,
    /// `redirect_uri`) pair (the concrete-table lookup driving the `/authorize`
    /// fast path), or `None` when absent.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to an [`AuthorizationCodeGrant`].
    fn grant_by_client_and_redirect(
        &mut self,
        client_id: &str,
        redirect_uri: &Url,
    ) -> Result<Option<AuthorizationCodeGrant>, AuthorizationServerError>;

    /// Find the standing device grant for a (`client_id`, `device_name`) pair
    /// (the concrete-table lookup a re-pairing upserts against), or `None` when
    /// absent.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to a [`DeviceGrant`].
    fn device_grant_by_client_and_device_name(
        &mut self,
        client_id: &str,
        device_name: &str,
    ) -> Result<Option<DeviceGrant>, AuthorizationServerError>;

    /// Insert a brand-new **authorization-code** grant row (a plain single-table
    /// insert). The caller hands the concrete grant — which table a write lands
    /// in is decided in the domain, not by the store re-inspecting a polymorphic
    /// value. The scope-union re-approval path is
    /// `upsert_authorization_code_grant`,
    /// which reads then chooses this or [`Self::update_authorization_code_grant`].
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the insert fails.
    fn create_authorization_code_grant(
        &mut self,
        grant: &AuthorizationCodeGrant,
    ) -> Result<(), AuthorizationServerError>;

    /// Insert a brand-new **device** grant row (a plain single-table insert).
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the insert fails.
    fn create_device_grant(&mut self, grant: &DeviceGrant) -> Result<(), AuthorizationServerError>;

    /// Overwrite the mutable fields (`scopes`, `granted_at`, `patient`) of the
    /// **authorization-code** grant identified by `grant.id` — the write half of
    /// a re-approval, after the action has folded the re-approval into `grant`
    /// via [`absorb_reapproval`](crate::domain::grant::CumulativeConsent).
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails.
    fn update_authorization_code_grant(
        &mut self,
        grant: &AuthorizationCodeGrant,
    ) -> Result<(), AuthorizationServerError>;

    /// Overwrite the mutable fields of the **device** grant identified by
    /// `grant.id` — the write half of a device re-pairing.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails.
    fn update_device_grant(&mut self, grant: &DeviceGrant) -> Result<(), AuthorizationServerError>;

    /// Delete the **authorization-code** grant `id`, returning `true` iff a row
    /// was removed. Half of a revoke; grant ids are UUIDs unique across both
    /// tables, so at most one of this and [`Self::delete_device_grant`] hits a
    /// row.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the delete fails.
    fn delete_authorization_code_grant(&mut self, id: &str) -> Result<bool, AuthorizationServerError>;

    /// Delete the **device** grant `id`, returning `true` iff a row was removed.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the delete fails.
    fn delete_device_grant(&mut self, id: &str) -> Result<bool, AuthorizationServerError>;
}
