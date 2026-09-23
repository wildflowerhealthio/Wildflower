use chrono::{DateTime, Utc};
use url::Url;

use super::GatekeeperTx;
use crate::domain::authorization_code::IssuedAuthorizationCode;
use crate::domain::authorization_request::AuthorizationRequest;
use crate::domain::client::Client;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::grant::{AuthorizationCodeGrant, DeviceGrant, Grant};
use crate::domain::pending_consent::PendingConsentHead;
use crate::domain::refresh_token::{RefreshToken, RefreshTokenFamily};
use crate::domain::signing_key::SigningKey;

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

    /// See [`GatekeeperTx::oldest_pending_consent_head`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::oldest_pending_consent_head`]'s error.
    fn oldest_pending_consent_head(&self) -> Result<Option<PendingConsentHead>, GatekeeperError> {
        self.with_connection(|tx| tx.oldest_pending_consent_head())
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
    fn deny_authorization_request(&self, id: &str) -> Result<bool, GatekeeperError> {
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
    ) -> Result<Option<IssuedAuthorizationCode>, GatekeeperError> {
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
    ) -> Result<Option<IssuedAuthorizationCode>, GatekeeperError> {
        self.with_connection(|tx| tx.authorization_code_by_request_id(request_id))
    }

    /// See [`GatekeeperTx::issue_authorization_code`].
    ///
    /// # Errors
    ///
    /// Propagates [`GatekeeperTx::issue_authorization_code`]'s error.
    fn issue_authorization_code(
        &self,
        code: &IssuedAuthorizationCode,
    ) -> Result<(), GatekeeperError> {
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
