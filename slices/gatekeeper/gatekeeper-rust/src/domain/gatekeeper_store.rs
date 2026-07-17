//! The gatekeeper persistence **port**, split into two pure traits the domain
//! depends on:
//!
//! - [`GatekeeperTx`] is the primitive contract — every single-statement CRUD
//!   operation the domain needs, over the gatekeeper's domain types, taking
//!   `&mut self` so a batch of them can run against one connection. It signals
//!   absence/conflict through return types (`Option` / `bool`) rather than
//!   semantic errors, raising only the opaque
//!   [`Infrastructure`](GatekeeperError::Infrastructure) failure. The semantic
//!   outcomes (the various `*NotFound`) are decided one layer up, in
//!   `domain::capabilities`.
//! - [`GatekeeperStore`] is the **transaction seam**: it hands the domain a
//!   [`GatekeeperTx`] scoped to one connection, either in autocommit
//!   ([`with_connection`](GatekeeperStore::with_connection)) or wrapped in a
//!   [`transaction`](GatekeeperStore::transaction) /
//!   [`immediate_transaction`](GatekeeperStore::immediate_transaction). A
//!   multi-statement operation that must be atomic (a grant upsert's
//!   read-merge-write, a token rotation's consume-then-decide, a revoke's
//!   delete-both-then-expire) is composed in `domain::capabilities` from
//!   `GatekeeperTx` primitives inside one of these transactions — so the logic
//!   lives in the pure domain, unit-tested against the in-memory
//!   `FakeGatekeeperStore`, and the `SQLite` adapter carries only the primitives
//!   plus the three transaction runners.
//!
//! Every read/simple-write the routes call standalone is still available
//! directly on [`GatekeeperStore`] as a **default** method that runs the
//! primitive through [`with_connection`](GatekeeperStore::with_connection), so
//! callers that don't compose keep calling `store.client_by_id(..)` unchanged.
//!
//! The `SQLite` adapter lives in [`crate::db`] as `SqliteGatekeeperStore` (its
//! `SqliteGatekeeperTx` implements [`GatekeeperTx`]); the in-memory
//! `FakeGatekeeperStore` in `domain::capabilities` substitutes for it in the
//! semantic-mapping unit tests. Mirrors `collector-rust`'s `RemotesStore` and
//! `tunnel-rust`'s `TunnelStore`, scaled up to the gatekeeper's six persistence
//! concerns — plus the transaction seam neither of those simpler CRUD stores
//! needed.

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
/// lets [`GatekeeperStore`] hand a batch of these out inside one transaction; a
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

    /// Persist a freshly-constructed `AuthorizationRequest`, opportunistically
    /// pruning expired rows first.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] if the prune or insert fails (for
    /// example a unique-constraint violation on the id).
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

/// The transaction seam over [`GatekeeperTx`]. The domain holds an
/// `impl GatekeeperStore` and either runs a single primitive standalone (the
/// default methods below, each a one-liner over
/// [`with_connection`](Self::with_connection)) or composes several into an
/// atomic operation inside [`transaction`](Self::transaction) /
/// [`immediate_transaction`](Self::immediate_transaction). This is what let the
/// seven former compound store methods (grant upserts, the three-state consume,
/// the delete-both-then-expire revoke) move into `domain::capabilities` as
/// pure, fake-tested scripts: the store no longer owns any multi-statement
/// business logic, only the primitives and the three ways to scope them to a
/// connection.
///
/// The six concerns (clients, signing keys, authorization requests,
/// authorization codes, refresh-token families, grants) all hang off one port
/// because they share one database and one axum state.
pub trait GatekeeperStore {
    /// The connection-scoped primitive handle this store hands to a closure. For
    /// the `SQLite` adapter it wraps a checked-out diesel connection; for the
    /// fake it wraps the in-memory maps.
    type Tx<'a>: GatekeeperTx
    where
        Self: 'a;

    /// Run `f` with a [`GatekeeperTx`] in **autocommit** mode — each primitive
    /// `f` calls is its own implicit transaction, exactly as a bare checked-out
    /// connection behaves. The single-statement default methods below all route
    /// through here; composing multiple writes that must be atomic is
    /// [`transaction`](Self::transaction)'s job instead.
    ///
    /// # Errors
    ///
    /// Whatever `f` returns, plus [`GatekeeperError::Infrastructure`] if a
    /// connection can't be acquired.
    fn with_connection<T>(
        &self,
        f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T, GatekeeperError>,
    ) -> Result<T, GatekeeperError>;

    /// Run `f` inside a single **deferred** transaction, committed if `f`
    /// returns `Ok` and rolled back if it returns `Err`. Use for a batch of
    /// primitives that must land together but have no read-before-write
    /// lost-update hazard (a revoke's delete + expire, a rotation's
    /// consume-then-decide).
    ///
    /// # Errors
    ///
    /// Whatever `f` returns, plus [`GatekeeperError::Infrastructure`] if the
    /// connection, `BEGIN`, or `COMMIT` fails.
    fn transaction<T>(
        &self,
        f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T, GatekeeperError>,
    ) -> Result<T, GatekeeperError>;

    /// Run `f` inside a single **immediate** transaction (`BEGIN IMMEDIATE`
    /// takes the write lock up front, before any read). Use for a
    /// read-then-write that must not lose a concurrent update — the grant
    /// upserts read the standing grant, union scopes, then write, and two
    /// concurrent approvals must serialise at the read rather than both reading
    /// the pre-merge row and one losing its scope union.
    ///
    /// # Errors
    ///
    /// Whatever `f` returns, plus [`GatekeeperError::Infrastructure`] if the
    /// connection, `BEGIN IMMEDIATE`, or `COMMIT` fails.
    fn immediate_transaction<T>(
        &self,
        f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T, GatekeeperError>,
    ) -> Result<T, GatekeeperError>;

    // ----- standalone convenience (single-statement, autocommit) ---------
    //
    // Each delegates one primitive through `with_connection`, so routes and boot
    // code that don't compose keep calling `store.<op>(..)` directly. Operations
    // that only ever run *inside* a composed transaction (the grant
    // update/delete halves, the two consume probes, the per-client family
    // expiry) are intentionally absent here — they live on `GatekeeperTx` only.

    /// See [`GatekeeperTx::client_by_id`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::client_by_id`]'s error.
    fn client_by_id(&self, client_id: &str) -> Result<Option<Client>, GatekeeperError> {
        self.with_connection(|tx| tx.client_by_id(client_id))
    }

    /// See [`GatekeeperTx::upsert_client`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::upsert_client`]'s error.
    fn upsert_client(&self, client: &Client) -> Result<(), GatekeeperError> {
        self.with_connection(|tx| tx.upsert_client(client))
    }

    /// See [`GatekeeperTx::all_signing_keys`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::all_signing_keys`]'s error.
    fn all_signing_keys(&self) -> Result<Vec<SigningKey>, GatekeeperError> {
        self.with_connection(|tx| tx.all_signing_keys())
    }

    /// See [`GatekeeperTx::active_signing_key`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::active_signing_key`]'s error.
    fn active_signing_key(&self) -> Result<Option<SigningKey>, GatekeeperError> {
        self.with_connection(|tx| tx.active_signing_key())
    }

    /// See [`GatekeeperTx::has_active_signing_key`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::has_active_signing_key`]'s error.
    fn has_active_signing_key(&self) -> Result<bool, GatekeeperError> {
        self.with_connection(|tx| tx.has_active_signing_key())
    }

    /// See [`GatekeeperTx::insert_signing_key`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::insert_signing_key`]'s error.
    fn insert_signing_key(&self, key: &SigningKey) -> Result<(), GatekeeperError> {
        self.with_connection(|tx| tx.insert_signing_key(key))
    }

    /// See [`GatekeeperTx::authorization_request_by_id`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::authorization_request_by_id`]'s error.
    fn authorization_request_by_id(
        &self,
        id: &str,
    ) -> Result<Option<AuthorizationRequest>, GatekeeperError> {
        self.with_connection(|tx| tx.authorization_request_by_id(id))
    }

    /// See [`GatekeeperTx::authorization_request_by_user_code`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::authorization_request_by_user_code`]'s error.
    fn authorization_request_by_user_code(
        &self,
        user_code: &str,
    ) -> Result<Option<AuthorizationRequest>, GatekeeperError> {
        self.with_connection(|tx| tx.authorization_request_by_user_code(user_code))
    }

    /// See [`GatekeeperTx::pending_authorization_request_by_user_code`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::pending_authorization_request_by_user_code`]'s
    /// error.
    fn pending_authorization_request_by_user_code(
        &self,
        user_code: &str,
    ) -> Result<Option<AuthorizationRequest>, GatekeeperError> {
        self.with_connection(|tx| tx.pending_authorization_request_by_user_code(user_code))
    }

    /// See [`GatekeeperTx::oldest_pending_device_user_code`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::oldest_pending_device_user_code`]'s error.
    fn oldest_pending_device_user_code(&self) -> Result<Option<String>, GatekeeperError> {
        self.with_connection(|tx| tx.oldest_pending_device_user_code())
    }

    /// See [`GatekeeperTx::insert_authorization_request`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::insert_authorization_request`]'s error.
    fn insert_authorization_request(
        &self,
        request: &AuthorizationRequest,
    ) -> Result<(), GatekeeperError> {
        self.with_connection(|tx| tx.insert_authorization_request(request))
    }

    /// See [`GatekeeperTx::approve_authorization_request`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::approve_authorization_request`]'s error.
    fn approve_authorization_request(
        &self,
        id: &str,
        granted_scopes: &[String],
        patient: Option<&str>,
        device_name: Option<&str>,
    ) -> Result<bool, GatekeeperError> {
        self.with_connection(|tx| {
            tx.approve_authorization_request(id, granted_scopes, patient, device_name)
        })
    }

    /// See [`GatekeeperTx::deny_authorization_request`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::deny_authorization_request`]'s error.
    fn deny_authorization_request(&self, id: &str) -> Result<(), GatekeeperError> {
        self.with_connection(|tx| tx.deny_authorization_request(id))
    }

    /// See [`GatekeeperTx::consume_approved_authorization_request`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::consume_approved_authorization_request`]'s
    /// error.
    fn consume_approved_authorization_request(&self, id: &str) -> Result<bool, GatekeeperError> {
        self.with_connection(|tx| tx.consume_approved_authorization_request(id))
    }

    /// See [`GatekeeperTx::record_device_poll`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::record_device_poll`]'s error.
    fn record_device_poll(
        &self,
        id: &str,
        polled_at: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        self.with_connection(|tx| tx.record_device_poll(id, polled_at))
    }

    /// See [`GatekeeperTx::redeem_authorization_code`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::redeem_authorization_code`]'s error.
    fn redeem_authorization_code(
        &self,
        code: &str,
    ) -> Result<Option<AuthorizationCode>, GatekeeperError> {
        self.with_connection(|tx| tx.redeem_authorization_code(code))
    }

    /// See [`GatekeeperTx::authorization_code_by_request_id`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::authorization_code_by_request_id`]'s error.
    fn authorization_code_by_request_id(
        &self,
        request_id: &str,
    ) -> Result<Option<AuthorizationCode>, GatekeeperError> {
        self.with_connection(|tx| tx.authorization_code_by_request_id(request_id))
    }

    /// See [`GatekeeperTx::issue_authorization_code`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::issue_authorization_code`]'s error.
    fn issue_authorization_code(&self, code: &AuthorizationCode) -> Result<(), GatekeeperError> {
        self.with_connection(|tx| tx.issue_authorization_code(code))
    }

    /// See [`GatekeeperTx::insert_refresh_token_family_row`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::insert_refresh_token_family_row`]'s error.
    fn insert_refresh_token_family_row(
        &self,
        family: &RefreshTokenFamily,
    ) -> Result<(), GatekeeperError> {
        self.with_connection(|tx| tx.insert_refresh_token_family_row(family))
    }

    /// See [`GatekeeperTx::insert_refresh_token`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::insert_refresh_token`]'s error.
    fn insert_refresh_token(&self, token: &RefreshToken) -> Result<(), GatekeeperError> {
        self.with_connection(|tx| tx.insert_refresh_token(token))
    }

    /// See [`GatekeeperTx::refresh_token_with_family_by_hash`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::refresh_token_with_family_by_hash`]'s error.
    fn refresh_token_with_family_by_hash(
        &self,
        token_hash: &str,
    ) -> Result<Option<(RefreshToken, RefreshTokenFamily)>, GatekeeperError> {
        self.with_connection(|tx| tx.refresh_token_with_family_by_hash(token_hash))
    }

    /// See [`GatekeeperTx::expire_refresh_token_family`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::expire_refresh_token_family`]'s error.
    fn expire_refresh_token_family(
        &self,
        family_id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        self.with_connection(|tx| tx.expire_refresh_token_family(family_id, now))
    }

    /// See [`GatekeeperTx::expire_refresh_token_families_for_authorization_code`].
    ///
    /// # Errors
    ///
    /// Propagates
    /// [`GatekeeperTx::expire_refresh_token_families_for_authorization_code`]'s
    /// error.
    fn expire_refresh_token_families_for_authorization_code(
        &self,
        authorization_code_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        self.with_connection(|tx| {
            tx.expire_refresh_token_families_for_authorization_code(authorization_code_hash, now)
        })
    }

    /// See [`GatekeeperTx::all_grants`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::all_grants`]'s error.
    fn all_grants(&self) -> Result<Vec<Grant>, GatekeeperError> {
        self.with_connection(|tx| tx.all_grants())
    }

    /// See [`GatekeeperTx::grant_by_id`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::grant_by_id`]'s error.
    fn grant_by_id(&self, id: &str) -> Result<Option<Grant>, GatekeeperError> {
        self.with_connection(|tx| tx.grant_by_id(id))
    }

    /// See [`GatekeeperTx::grant_by_client_and_redirect`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::grant_by_client_and_redirect`]'s error.
    fn grant_by_client_and_redirect(
        &self,
        client_id: &str,
        redirect_uri: &Url,
    ) -> Result<Option<AuthorizationCodeGrant>, GatekeeperError> {
        self.with_connection(|tx| tx.grant_by_client_and_redirect(client_id, redirect_uri))
    }

    /// See [`GatekeeperTx::device_grant_by_client_and_device_name`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::device_grant_by_client_and_device_name`]'s
    /// error.
    fn device_grant_by_client_and_device_name(
        &self,
        client_id: &str,
        device_name: &str,
    ) -> Result<Option<DeviceGrant>, GatekeeperError> {
        self.with_connection(|tx| tx.device_grant_by_client_and_device_name(client_id, device_name))
    }

    /// See [`GatekeeperTx::create_authorization_code_grant`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::create_authorization_code_grant`]'s error.
    fn create_authorization_code_grant(
        &self,
        grant: &AuthorizationCodeGrant,
    ) -> Result<(), GatekeeperError> {
        self.with_connection(|tx| tx.create_authorization_code_grant(grant))
    }

    /// See [`GatekeeperTx::create_device_grant`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::create_device_grant`]'s error.
    fn create_device_grant(&self, grant: &DeviceGrant) -> Result<(), GatekeeperError> {
        self.with_connection(|tx| tx.create_device_grant(grant))
    }
}
