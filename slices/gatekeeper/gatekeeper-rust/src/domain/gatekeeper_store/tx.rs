use chrono::{DateTime, Utc};
use url::Url;

use crate::domain::authorization_code::AuthorizationCode;
use crate::domain::authorization_request::AuthorizationRequest;
use crate::domain::client::Client;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::grant::{AuthorizationCodeGrant, DeviceGrant, Grant};
use crate::domain::refresh_token::{RefreshToken, RefreshTokenFamily};
use crate::domain::signing_key::SigningKey;

/// The primitive persistence contract, scoped to one connection. Every method
/// is a single logical statement over the domain types — absence as `Option`,
/// an affected-row outcome as `bool` — raising only
/// [`GatekeeperError::Infrastructure`]. `&mut self` (rather than `&self`) is what
/// lets [`GatekeeperStore`](super::GatekeeperStore) hand a batch of these out inside one transaction; a
/// domain action composes several into an atomic operation without any
/// per-operation transaction method on the store.
///
/// The `SQLite` adapter's `SqliteGatekeeperTx` implements this over a
/// checked-out diesel connection; the in-memory `FakeGatekeeperTx` implements it
/// over the fake's maps.
pub trait GatekeeperTx {
    // ----- clients -------------------------------------------------------

    /// Look up a registered client by its `client_id`, or `None` when no client
    /// has this id.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to a [`Client`].
    fn client_by_id(&mut self, client_id: &str) -> Result<Option<Client>, GatekeeperError>;

    /// Insert a client, or update its policy fields if one with the same
    /// `client_id` already exists (`ON CONFLICT … DO UPDATE`) — used by
    /// first-boot seeding so a seeded client's definition always matches the
    /// code, preserving `registered_at` and `disabled_at`.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the upsert fails.
    fn upsert_client(&mut self, client: &Client) -> Result<(), GatekeeperError>;

    // ----- signing keys --------------------------------------------------

    /// Load every signing key, active keys first then by `kid`.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the read fails or any returned row
    /// cannot be mapped to a [`SigningKey`].
    fn all_signing_keys(&mut self) -> Result<Vec<SigningKey>, GatekeeperError>;

    /// Load the active signing key, or `None` when none is active.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to a [`SigningKey`].
    fn active_signing_key(&mut self) -> Result<Option<SigningKey>, GatekeeperError>;

    /// Whether an active signing key exists, without loading its (private) key
    /// material — a cheap presence probe.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the query fails.
    fn has_active_signing_key(&mut self) -> Result<bool, GatekeeperError>;

    /// Persist a signing key.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the insert fails (for example a
    /// unique-constraint violation on the `kid`).
    fn insert_signing_key(&mut self, key: &SigningKey) -> Result<(), GatekeeperError>;

    // ----- authorization requests ----------------------------------------

    /// Load an authorization request by its primary id (the `device_code` for
    /// device-flow, otherwise an internal UUID), or `None` when absent.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to an [`AuthorizationRequest`].
    fn authorization_request_by_id(
        &mut self,
        id: &str,
    ) -> Result<Option<AuthorizationRequest>, GatekeeperError>;

    /// Load *any* authorization request bearing the human-typed `user_code`,
    /// regardless of status, or `None` when absent. Callers that need a live
    /// request must use [`Self::pending_authorization_request_by_user_code`].
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to an [`AuthorizationRequest`].
    fn authorization_request_by_user_code(
        &mut self,
        user_code: &str,
    ) -> Result<Option<AuthorizationRequest>, GatekeeperError>;

    /// Load the *pending* authorization request for `user_code` (the
    /// `status = 'pending'` filter stops a stale terminal row from shadowing a
    /// live one), or `None` when none is pending.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to an [`AuthorizationRequest`].
    fn pending_authorization_request_by_user_code(
        &mut self,
        user_code: &str,
    ) -> Result<Option<AuthorizationRequest>, GatekeeperError>;

    /// The `user_code` of the oldest pending, non-expired device-code request —
    /// the FIFO head the host popup surfaces — or `None` when none exists.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the read fails or the column can't
    /// be decoded as `String`.
    fn oldest_pending_device_user_code(&mut self) -> Result<Option<String>, GatekeeperError>;

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
    /// [`GatekeeperError::Infrastructure`] if the insert fails (for example a
    /// unique-constraint violation on the id, or a collision with a *live*
    /// pending request holding the same `user_code`).
    fn insert_authorization_request(
        &mut self,
        request: &AuthorizationRequest,
    ) -> Result<(), GatekeeperError>;

    /// Mark a *pending* `id` approved with `granted_scopes`, an optional patient
    /// context, and an optional adjusted `device_name`, returning `true` iff a
    /// pending row was actually transitioned (the `status = 'pending'` guard
    /// makes a terminal row unflippable, and the affected-row count exposes a
    /// concurrent transition as `false`).
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the update fails.
    fn approve_authorization_request(
        &mut self,
        id: &str,
        granted_scopes: &[String],
        patient: Option<&str>,
        device_name: Option<&str>,
    ) -> Result<bool, GatekeeperError>;

    /// Mark `id` denied.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the update fails.
    fn deny_authorization_request(&mut self, id: &str) -> Result<(), GatekeeperError>;

    /// Atomically claim an `approved` request for single-use redemption
    /// (`approved` → `expired` only if still `approved`), returning `true` iff
    /// this call won the race (RFC 8628 §3.4).
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the update fails.
    fn consume_approved_authorization_request(&mut self, id: &str)
        -> Result<bool, GatekeeperError>;

    /// Stamp `last_polled_at` so the next device-flow poll can be slow-down
    /// rate-limited.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the update fails.
    fn record_device_poll(
        &mut self,
        id: &str,
        polled_at: DateTime<Utc>,
    ) -> Result<(), GatekeeperError>;

    // ----- authorization codes -------------------------------------------

    /// Atomically read-and-delete the authorization `code` (`DELETE …
    /// RETURNING`), returning the row exactly once or `None` to any racer —
    /// RFC 6749 §10.5 single-use.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the delete-returning query fails or
    /// a returned row cannot be mapped to an [`AuthorizationCode`].
    fn redeem_authorization_code(
        &mut self,
        code: &str,
    ) -> Result<Option<AuthorizationCode>, GatekeeperError>;

    /// Look up the code issued for a given `request_id`, or `None` when absent —
    /// used by the Owner UI's polling endpoint to build the final redirect URL.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to an [`AuthorizationCode`].
    fn authorization_code_by_request_id(
        &mut self,
        request_id: &str,
    ) -> Result<Option<AuthorizationCode>, GatekeeperError>;

    /// Persist a freshly-minted authorization code.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the insert fails (for example a
    /// unique-constraint violation on the code).
    fn issue_authorization_code(&mut self, code: &AuthorizationCode)
        -> Result<(), GatekeeperError>;

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
    /// [`GatekeeperError::Infrastructure`] if the delete fails.
    fn delete_authorization_requests_expired_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, GatekeeperError>;

    /// Delete every authorization code whose `expires_at` fell before `cutoff`,
    /// returning how many rows went. Redemption already deletes a code as it is
    /// used, so this reaps only abandoned ones.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the delete fails.
    fn delete_authorization_codes_expired_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, GatekeeperError>;

    /// Delete every refresh-token family whose absolute deadline fell before
    /// `cutoff`, together with the tokens descended from it, returning how many
    /// **families** went — the counterpart to
    /// [`Self::expire_refresh_token_family`], which keeps the lineage readable.
    /// Self-contained: children before parents in its own (possibly nested)
    /// transaction, so the foreign key holds either way.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the transaction or either delete
    /// fails.
    fn delete_refresh_token_families_expired_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, GatekeeperError>;

    // ----- refresh-token families ----------------------------------------

    /// Persist a new refresh-token family **row only** — a single-table insert.
    /// Pairing it with its first token (so a family never persists tokenless) is
    /// the [`insert_refresh_token_family`](crate::domain::refresh_token::insert_refresh_token_family)
    /// action's job, sequencing this then [`Self::insert_refresh_token`].
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the insert fails.
    fn insert_refresh_token_family_row(
        &mut self,
        family: &RefreshTokenFamily,
    ) -> Result<(), GatekeeperError>;

    /// Persist the successor token in an existing family's rotation.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the insert fails (for example a
    /// unique-constraint violation on the token hash, or a foreign-key violation
    /// for an unknown family).
    fn insert_refresh_token(&mut self, token: &RefreshToken) -> Result<(), GatekeeperError>;

    /// Resolve a presented token hash to its row plus the owning family in one
    /// JOIN (consumed tokens resolve too — the caller distinguishes live from
    /// replayed via `consumed_at`), or `None` when absent.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the join fails or a returned row
    /// cannot be mapped to a [`RefreshToken`]/[`RefreshTokenFamily`] pair.
    fn refresh_token_with_family_by_hash(
        &mut self,
        token_hash: &str,
    ) -> Result<Option<(RefreshToken, RefreshTokenFamily)>, GatekeeperError>;

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
    /// [`GatekeeperError::Infrastructure`] if the update fails.
    fn stamp_refresh_token_consumed_if_live(
        &mut self,
        token_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<bool, GatekeeperError>;

    /// Whether any token row (live or consumed) bears `token_hash` — the
    /// existence probe that tells a replay (`true`) from a miss (`false`) after
    /// [`Self::stamp_refresh_token_consumed_if_live`] reported no live row.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the query fails.
    fn refresh_token_exists(&mut self, token_hash: &str) -> Result<bool, GatekeeperError>;

    /// End a token family (pull its `expires_at` back to `now` and stamp its
    /// still-live token consumed at the same instant). Rows are kept, not
    /// deleted, so the lineage stays auditable. Self-contained: the two updates
    /// run in this method's own (possibly nested) transaction, so it is atomic
    /// whether invoked standalone or composed inside a larger domain
    /// transaction.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the transaction or either update
    /// fails.
    fn expire_refresh_token_family(
        &mut self,
        family_id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError>;

    /// End every refresh-token family issued to a client, with the same
    /// expire-and-stamp semantics as [`Self::expire_refresh_token_family`] — the
    /// standing-credential half of a grant revoke.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the transaction or either update
    /// fails.
    fn expire_refresh_token_families_for_client(
        &mut self,
        client_id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError>;

    /// End every refresh-token family minted from a given authorization code
    /// (by the code's hash), with the same expire-and-stamp semantics as
    /// [`Self::expire_refresh_token_family`] — authorization-code reuse detection
    /// (RFC 6749 §4.1.2). A code that never minted a family is a no-op.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the transaction or either update
    /// fails.
    fn expire_refresh_token_families_for_authorization_code(
        &mut self,
        authorization_code_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError>;

    // ----- grants --------------------------------------------------------

    /// All grants in `granted_at` order — the cross-kind read off the `grants`
    /// view backing the Owner UI's access index.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the view read fails or a returned
    /// row cannot be mapped to a [`Grant`].
    fn all_grants(&mut self) -> Result<Vec<Grant>, GatekeeperError>;

    /// Load a single grant by primary id (a cross-kind read off the `grants`
    /// view; ids are UUIDs unique across both concrete tables), or `None` when
    /// absent.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the view read fails or the returned
    /// row cannot be mapped to a [`Grant`].
    fn grant_by_id(&mut self, id: &str) -> Result<Option<Grant>, GatekeeperError>;

    /// Find the standing authorization-code grant for a (`client_id`,
    /// `redirect_uri`) pair (the concrete-table lookup driving the `/authorize`
    /// fast path), or `None` when absent.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to an [`AuthorizationCodeGrant`].
    fn grant_by_client_and_redirect(
        &mut self,
        client_id: &str,
        redirect_uri: &Url,
    ) -> Result<Option<AuthorizationCodeGrant>, GatekeeperError>;

    /// Find the standing device grant for a (`client_id`, `device_name`) pair
    /// (the concrete-table lookup a re-pairing upserts against), or `None` when
    /// absent.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to a [`DeviceGrant`].
    fn device_grant_by_client_and_device_name(
        &mut self,
        client_id: &str,
        device_name: &str,
    ) -> Result<Option<DeviceGrant>, GatekeeperError>;

    /// Insert a brand-new **authorization-code** grant row (a plain single-table
    /// insert). The caller hands the concrete grant — which table a write lands
    /// in is decided in the domain, not by the store re-inspecting a polymorphic
    /// value. The scope-union re-approval path is
    /// `upsert_authorization_code_grant`,
    /// which reads then chooses this or [`Self::update_authorization_code_grant`].
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the insert fails.
    fn create_authorization_code_grant(
        &mut self,
        grant: &AuthorizationCodeGrant,
    ) -> Result<(), GatekeeperError>;

    /// Insert a brand-new **device** grant row (a plain single-table insert).
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the insert fails.
    fn create_device_grant(&mut self, grant: &DeviceGrant) -> Result<(), GatekeeperError>;

    /// Overwrite the mutable fields (`scopes`, `granted_at`, `patient`) of the
    /// **authorization-code** grant identified by `grant.id` — the write half of
    /// a re-approval, after the action has folded the re-approval into `grant`
    /// via [`absorb_reapproval`](crate::domain::grant::CumulativeConsent).
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the update fails.
    fn update_authorization_code_grant(
        &mut self,
        grant: &AuthorizationCodeGrant,
    ) -> Result<(), GatekeeperError>;

    /// Overwrite the mutable fields of the **device** grant identified by
    /// `grant.id` — the write half of a device re-pairing.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the update fails.
    fn update_device_grant(&mut self, grant: &DeviceGrant) -> Result<(), GatekeeperError>;

    /// Delete the **authorization-code** grant `id`, returning `true` iff a row
    /// was removed. Half of a revoke; grant ids are UUIDs unique across both
    /// tables, so at most one of this and [`Self::delete_device_grant`] hits a
    /// row.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the delete fails.
    fn delete_authorization_code_grant(&mut self, id: &str) -> Result<bool, GatekeeperError>;

    /// Delete the **device** grant `id`, returning `true` iff a row was removed.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the delete fails.
    fn delete_device_grant(&mut self, id: &str) -> Result<bool, GatekeeperError>;
}
