//! The [`GatekeeperStore`] **port** — the pure trait the domain depends on for
//! persistence. No diesel or axum here: the port speaks primitive CRUD over the
//! gatekeeper's domain types, signalling absence/conflict through return types
//! (`Option` / `bool` / [`RefreshTokenConsumeOutcome`]) rather than semantic
//! errors, and raising only the opaque
//! [`Infrastructure`](GatekeeperError::Infrastructure) failure. The semantic
//! outcomes (the various `*NotFound`) are decided one layer up, in
//! [`crate::domain::actions`], so both the `SQLite` adapter and an in-memory
//! test fake implement the same primitive contract.
//!
//! The `SQLite` adapter lives in [`crate::db`] as `SqliteGatekeeperStore`; the
//! in-memory `FakeGatekeeperStore` in [`crate::domain::actions`] substitutes for
//! it in the semantic-mapping unit tests. Mirrors `collector-rust`'s
//! `RemotesStore` and `tunnel-rust`'s `TunnelStore`, scaled up to the
//! gatekeeper's six persistence concerns.

use chrono::{DateTime, Utc};
use url::Url;

use crate::domain::authorization_code::AuthorizationCode;
use crate::domain::authorization_request::AuthorizationRequest;
use crate::domain::client::Client;
use crate::domain::error::GatekeeperError;
use crate::domain::grant::{AuthorizationCodeGrant, DeviceGrant, Grant};
use crate::domain::refresh_token::{RefreshToken, RefreshTokenConsumeOutcome, RefreshTokenFamily};
use crate::domain::signing_key::SigningKey;

/// The persistence port for the gatekeeper: every store operation the domain
/// needs, over the domain types, raising only the opaque
/// [`GatekeeperError::Infrastructure`] failure. Absence and conflict are
/// return-type signals (`Option` when a keyed row may be missing, `bool` for an
/// affected-row outcome, [`RefreshTokenConsumeOutcome`] for the three-state
/// consume) — NOT semantic errors. [`crate::domain::actions`] maps those signals
/// onto the semantic `*NotFound` variants; the `SQLite` adapter
/// (`crate::db::SqliteGatekeeperStore`) implements the primitive contract, and
/// the in-memory `FakeGatekeeperStore` swaps in for it in unit tests.
///
/// The six concerns (clients, signing keys, authorization requests,
/// authorization codes, refresh-token families, grants) all hang off one trait
/// because they share one database and one axum state; the `SQLite` adapter
/// checks a connection out of the shared pool per call and delegates each method
/// to the matching query body in `crate::db`.
pub trait GatekeeperStore {
    // ----- clients -------------------------------------------------------

    /// Look up a registered client by its `client_id`, or `None` when no client
    /// has this id.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to a [`Client`].
    fn client_by_id(&self, client_id: &str) -> Result<Option<Client>, GatekeeperError>;

    /// Persist a new OAuth client.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the insert fails (for example a
    /// unique-constraint violation on the `client_id`).
    fn register_client(&self, client: &Client) -> Result<(), GatekeeperError>;

    /// Insert a client, or update its policy fields if one with the same
    /// `client_id` already exists (`ON CONFLICT … DO UPDATE`) — used by
    /// first-boot seeding so a seeded client's definition always matches the
    /// code, preserving `registered_at` and `disabled_at`.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the upsert fails.
    fn upsert_client(&self, client: &Client) -> Result<(), GatekeeperError>;

    // ----- signing keys --------------------------------------------------

    /// Load every signing key, active keys first then by `kid`.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the read fails or any returned row
    /// cannot be mapped to a [`SigningKey`].
    fn all_signing_keys(&self) -> Result<Vec<SigningKey>, GatekeeperError>;

    /// Load the active signing key, or `None` when none is active.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to a [`SigningKey`].
    fn active_signing_key(&self) -> Result<Option<SigningKey>, GatekeeperError>;

    /// Whether an active signing key exists, without loading its (private) key
    /// material — a cheap presence probe.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the query fails.
    fn has_active_signing_key(&self) -> Result<bool, GatekeeperError>;

    /// Persist a signing key.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the insert fails (for example a
    /// unique-constraint violation on the `kid`).
    fn insert_signing_key(&self, key: &SigningKey) -> Result<(), GatekeeperError>;

    // ----- authorization requests ----------------------------------------

    /// Load an authorization request by its primary id (the `device_code` for
    /// device-flow, otherwise an internal UUID), or `None` when absent.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to an [`AuthorizationRequest`].
    fn authorization_request_by_id(
        &self,
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
        &self,
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
        &self,
        user_code: &str,
    ) -> Result<Option<AuthorizationRequest>, GatekeeperError>;

    /// The `user_code` of the oldest pending, non-expired device-code request —
    /// the FIFO head the host popup surfaces — or `None` when none exists.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the read fails or the column can't
    /// be decoded as `String`.
    fn oldest_pending_device_user_code(&self) -> Result<Option<String>, GatekeeperError>;

    /// Persist a freshly-constructed `AuthorizationRequest`, opportunistically
    /// pruning expired rows first.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the prune or insert fails (for
    /// example a unique-constraint violation on the id).
    fn insert_authorization_request(
        &self,
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
        &self,
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
    fn deny_authorization_request(&self, id: &str) -> Result<(), GatekeeperError>;

    /// Atomically claim an `approved` request for single-use redemption
    /// (`approved` → `expired` only if still `approved`), returning `true` iff
    /// this call won the race (RFC 8628 §3.4).
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the update fails.
    fn consume_approved_authorization_request(&self, id: &str) -> Result<bool, GatekeeperError>;

    /// Stamp `last_polled_at` so the next device-flow poll can be slow-down
    /// rate-limited.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the update fails.
    fn record_device_poll(&self, id: &str, polled_at: DateTime<Utc>)
        -> Result<(), GatekeeperError>;

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
        &self,
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
        &self,
        request_id: &str,
    ) -> Result<Option<AuthorizationCode>, GatekeeperError>;

    /// Persist a freshly-minted authorization code.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the insert fails (for example a
    /// unique-constraint violation on the code).
    fn issue_authorization_code(&self, code: &AuthorizationCode) -> Result<(), GatekeeperError>;

    // ----- refresh-token families ----------------------------------------

    /// Persist a new refresh-token family alongside its first token in one
    /// transaction (a family with no token, or a token with no family, is
    /// unrepresentable on purpose).
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the transaction or either insert
    /// fails.
    fn insert_refresh_token_family(
        &self,
        family: &RefreshTokenFamily,
        first_token: &RefreshToken,
    ) -> Result<(), GatekeeperError>;

    /// Persist the successor token in an existing family's rotation.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the insert fails (for example a
    /// unique-constraint violation on the token hash, or a foreign-key violation
    /// for an unknown family).
    fn insert_refresh_token(&self, token: &RefreshToken) -> Result<(), GatekeeperError>;

    /// Resolve a presented token hash to its row plus the owning family in one
    /// JOIN (consumed tokens resolve too — the caller distinguishes live from
    /// replayed via `consumed_at`), or `None` when absent.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the join fails or a returned row
    /// cannot be mapped to a [`RefreshToken`]/[`RefreshTokenFamily`] pair.
    fn refresh_token_with_family_by_hash(
        &self,
        token_hash: &str,
    ) -> Result<Option<(RefreshToken, RefreshTokenFamily)>, GatekeeperError>;

    /// Look up a single token by hash, or `None` when absent — enough for
    /// callers that don't need the family facts.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to a [`RefreshToken`].
    fn refresh_token_by_hash(
        &self,
        token_hash: &str,
    ) -> Result<Option<RefreshToken>, GatekeeperError>;

    /// Atomically consume a live refresh token, reporting which of the three
    /// [`RefreshTokenConsumeOutcome`] states the row was in.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the transaction, the update, or the
    /// existence probe fails.
    fn consume_refresh_token(
        &self,
        token_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<RefreshTokenConsumeOutcome, GatekeeperError>;

    /// Atomically rotate a refresh token: consume the presented token and, only
    /// if that succeeded, insert its successor — both in one transaction. The
    /// three-state outcome mirrors [`Self::consume_refresh_token`].
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the transaction, the update, the
    /// existence probe, or the successor insert fails.
    fn rotate_refresh_token(
        &self,
        presented_hash: &str,
        successor: &RefreshToken,
        now: DateTime<Utc>,
    ) -> Result<RefreshTokenConsumeOutcome, GatekeeperError>;

    /// End a token family (pull its `expires_at` back to `now` and stamp its
    /// still-live token consumed at the same instant). Rows are kept, not
    /// deleted, so the lineage stays auditable.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the transaction or either update
    /// fails.
    fn expire_refresh_token_family(
        &self,
        family_id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError>;

    /// End every refresh-token family issued to a client, with the same
    /// expire-and-stamp semantics as [`Self::expire_refresh_token_family`].
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the transaction or either update
    /// fails.
    fn expire_refresh_token_families_for_client(
        &self,
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
        &self,
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
    fn all_grants(&self) -> Result<Vec<Grant>, GatekeeperError>;

    /// Load a single grant by primary id (a cross-kind read off the `grants`
    /// view; ids are UUIDs unique across both concrete tables), or `None` when
    /// absent.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the view read fails or the returned
    /// row cannot be mapped to a [`Grant`].
    fn grant_by_id(&self, id: &str) -> Result<Option<Grant>, GatekeeperError>;

    /// Find the standing authorization-code grant for a (`client_id`,
    /// `redirect_uri`) pair (the concrete-table lookup driving the `/authorize`
    /// fast path), or `None` when absent.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to an [`AuthorizationCodeGrant`].
    fn grant_by_client_and_redirect(
        &self,
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
        &self,
        client_id: &str,
        device_name: &str,
    ) -> Result<Option<DeviceGrant>, GatekeeperError>;

    /// Insert a brand-new grant row into its kind's concrete table (a plain
    /// single-table insert). Chiefly a test/seed helper; the flows use
    /// [`Self::upsert_grant`] / [`Self::upsert_device_grant`].
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the insert fails.
    fn create_grant(&self, grant: &Grant) -> Result<(), GatekeeperError>;

    /// Insert or cumulatively update the standing **authorization-code** grant
    /// for `(client_id, redirect_uri)` in one transaction (scope union on
    /// re-approval).
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the transaction, the read, or the
    /// insert/update fails.
    fn upsert_grant(
        &self,
        client_id: &str,
        redirect_uri: &Url,
        scopes: &[String],
        patient: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError>;

    /// Insert or cumulatively update the standing **device** grant for
    /// `(client_id, device_name)` in one transaction, with the same
    /// cumulative-consent semantics as [`Self::upsert_grant`].
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the transaction, the read, or the
    /// insert/update fails.
    fn upsert_device_grant(
        &self,
        client_id: &str,
        device_name: &str,
        scopes: &[String],
        patient: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError>;

    /// Revoke a grant and expire the refresh-token families of its client in one
    /// transaction, returning `true` iff the grant existed — standing consent
    /// and standing credentials die together or not at all.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the transaction or any statement
    /// fails.
    fn revoke_grant_and_expire_client_families(
        &self,
        grant_id: &str,
        client_id: &str,
        now: DateTime<Utc>,
    ) -> Result<bool, GatekeeperError>;
}
