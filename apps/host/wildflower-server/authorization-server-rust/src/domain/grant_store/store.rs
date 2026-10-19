use chrono::{DateTime, Utc};
use url::Url;

use super::GrantTx;
use crate::domain::authorization_code::IssuedAuthorizationCode;
use crate::domain::authorization_request::AuthorizationRequest;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::browser_session::BrowserSession;
use crate::domain::client::Client;
use crate::domain::grant::{AuthorizationCodeGrant, DeviceGrant, Grant};
use crate::domain::pending_consent::NewestPendingConsent;
use crate::domain::refresh_token::{RefreshToken, RefreshTokenFamily};
use crate::domain::signing_key::SigningKey;

/// The transaction seam over [`GrantTx`]. The domain holds an
/// `impl GrantStore` and either runs a single primitive standalone (the
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
pub trait GrantStore {
    /// The connection-scoped primitive handle this store hands to a closure. For
    /// the `SQLite` adapter it wraps a checked-out diesel connection; for the
    /// fake it wraps the in-memory maps.
    type Tx<'a>: GrantTx
    where
        Self: 'a;

    /// Run `f` with a [`GrantTx`] in **autocommit** mode — each primitive
    /// `f` calls is its own implicit transaction, exactly as a bare checked-out
    /// connection behaves. The single-statement default methods below all route
    /// through here; composing multiple writes that must be atomic is
    /// [`transaction`](Self::transaction)'s job instead.
    ///
    /// # Errors
    ///
    /// Whatever `f` returns, plus [`AuthorizationServerError::Infrastructure`] if a
    /// connection can't be acquired.
    fn with_connection<T>(
        &self,
        f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T, AuthorizationServerError>,
    ) -> Result<T, AuthorizationServerError>;

    /// Run `f` inside a single **deferred** transaction, committed if `f`
    /// returns `Ok` and rolled back if it returns `Err`. Use for a batch of
    /// primitives that must land together but have no read-before-write
    /// lost-update hazard (a revoke's delete + expire, a rotation's
    /// consume-then-decide).
    ///
    /// # Errors
    ///
    /// Whatever `f` returns, plus [`AuthorizationServerError::Infrastructure`] if the
    /// connection, `BEGIN`, or `COMMIT` fails.
    fn transaction<T>(
        &self,
        f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T, AuthorizationServerError>,
    ) -> Result<T, AuthorizationServerError>;

    /// Run `f` inside a single **immediate** transaction (`BEGIN IMMEDIATE`
    /// takes the write lock up front, before any read). Use for a
    /// read-then-write that must not lose a concurrent update — the grant
    /// upserts read the standing grant, union scopes, then write, and two
    /// concurrent approvals must serialise at the read rather than both reading
    /// the pre-merge row and one losing its scope union.
    ///
    /// # Errors
    ///
    /// Whatever `f` returns, plus [`AuthorizationServerError::Infrastructure`] if the
    /// connection, `BEGIN IMMEDIATE`, or `COMMIT` fails.
    fn immediate_transaction<T>(
        &self,
        f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T, AuthorizationServerError>,
    ) -> Result<T, AuthorizationServerError>;

    // ----- standalone convenience (single-statement, autocommit) ---------
    //
    // Each delegates one primitive through `with_connection`, so routes and boot
    // code that don't compose keep calling `store.<op>(..)` directly. Operations
    // that only ever run *inside* a composed transaction (the grant
    // update/delete halves, the two consume probes, the per-client family
    // expiry) are intentionally absent here — they live on `GrantTx` only.

    /// See [`GrantTx::client_by_id`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::client_by_id`]'s error.
    fn client_by_id(&self, client_id: &str) -> Result<Option<Client>, AuthorizationServerError> {
        self.with_connection(|tx| tx.client_by_id(client_id))
    }

    /// See [`GrantTx::upsert_client`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::upsert_client`]'s error.
    fn upsert_client(&self, client: &Client) -> Result<(), AuthorizationServerError> {
        self.with_connection(|tx| tx.upsert_client(client))
    }

    /// See [`GrantTx::list_clients`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::list_clients`]'s error.
    fn list_clients(&self) -> Result<Vec<Client>, AuthorizationServerError> {
        self.with_connection(|tx| tx.list_clients())
    }

    /// See [`GrantTx::set_client_disabled`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::set_client_disabled`]'s error.
    fn set_client_disabled(
        &self,
        client_id: &str,
        disabled_at: Option<DateTime<Utc>>,
    ) -> Result<bool, AuthorizationServerError> {
        self.with_connection(|tx| tx.set_client_disabled(client_id, disabled_at))
    }

    /// See [`GrantTx::all_signing_keys`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::all_signing_keys`]'s error.
    fn all_signing_keys(&self) -> Result<Vec<SigningKey>, AuthorizationServerError> {
        self.with_connection(|tx| tx.all_signing_keys())
    }

    /// See [`GrantTx::active_signing_key`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::active_signing_key`]'s error.
    fn active_signing_key(&self) -> Result<Option<SigningKey>, AuthorizationServerError> {
        self.with_connection(|tx| tx.active_signing_key())
    }

    /// See [`GrantTx::has_active_signing_key`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::has_active_signing_key`]'s error.
    fn has_active_signing_key(&self) -> Result<bool, AuthorizationServerError> {
        self.with_connection(|tx| tx.has_active_signing_key())
    }

    /// See [`GrantTx::insert_signing_key`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::insert_signing_key`]'s error.
    fn insert_signing_key(&self, key: &SigningKey) -> Result<(), AuthorizationServerError> {
        self.with_connection(|tx| tx.insert_signing_key(key))
    }

    /// See [`GrantTx::authorization_request_by_id`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::authorization_request_by_id`]'s error.
    fn authorization_request_by_id(
        &self,
        id: &str,
    ) -> Result<Option<AuthorizationRequest>, AuthorizationServerError> {
        self.with_connection(|tx| tx.authorization_request_by_id(id))
    }

    /// See [`GrantTx::authorization_request_by_user_code`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::authorization_request_by_user_code`]'s error.
    fn authorization_request_by_user_code(
        &self,
        user_code: &str,
    ) -> Result<Option<AuthorizationRequest>, AuthorizationServerError> {
        self.with_connection(|tx| tx.authorization_request_by_user_code(user_code))
    }

    /// See [`GrantTx::pending_authorization_request_by_user_code`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::pending_authorization_request_by_user_code`]'s
    /// error.
    fn pending_authorization_request_by_user_code(
        &self,
        user_code: &str,
    ) -> Result<Option<AuthorizationRequest>, AuthorizationServerError> {
        self.with_connection(|tx| tx.pending_authorization_request_by_user_code(user_code))
    }

    /// See [`GrantTx::newest_pending_consent`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::newest_pending_consent`]'s error.
    fn newest_pending_consent(
        &self,
    ) -> Result<Option<NewestPendingConsent>, AuthorizationServerError> {
        self.with_connection(|tx| tx.newest_pending_consent())
    }

    /// See [`GrantTx::insert_authorization_request`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::insert_authorization_request`]'s error.
    fn insert_authorization_request(
        &self,
        request: &AuthorizationRequest,
    ) -> Result<(), AuthorizationServerError> {
        self.with_connection(|tx| tx.insert_authorization_request(request))
    }

    /// See [`GrantTx::approve_authorization_request`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::approve_authorization_request`]'s error.
    fn approve_authorization_request(
        &self,
        id: &str,
        granted_scopes: &[String],
        patient: Option<&str>,
        device_name: Option<&str>,
    ) -> Result<bool, AuthorizationServerError> {
        self.with_connection(|tx| {
            tx.approve_authorization_request(id, granted_scopes, patient, device_name)
        })
    }

    /// See [`GrantTx::deny_authorization_request`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::deny_authorization_request`]'s error.
    fn deny_authorization_request(&self, id: &str) -> Result<bool, AuthorizationServerError> {
        self.with_connection(|tx| tx.deny_authorization_request(id))
    }

    /// See [`GrantTx::raise_authorization_request_for_owner`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::raise_authorization_request_for_owner`]'s error.
    fn raise_authorization_request_for_owner(
        &self,
        id: &str,
    ) -> Result<bool, AuthorizationServerError> {
        self.with_connection(|tx| tx.raise_authorization_request_for_owner(id))
    }

    /// See [`GrantTx::acknowledge_session_shortfall`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::acknowledge_session_shortfall`]'s error.
    fn acknowledge_session_shortfall(&self, id: &str) -> Result<bool, AuthorizationServerError> {
        self.with_connection(|tx| tx.acknowledge_session_shortfall(id))
    }

    /// See [`GrantTx::consume_approved_authorization_request`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::consume_approved_authorization_request`]'s
    /// error.
    fn consume_approved_authorization_request(
        &self,
        id: &str,
    ) -> Result<bool, AuthorizationServerError> {
        self.with_connection(|tx| tx.consume_approved_authorization_request(id))
    }

    /// See [`GrantTx::record_device_poll`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::record_device_poll`]'s error.
    fn record_device_poll(
        &self,
        id: &str,
        polled_at: DateTime<Utc>,
    ) -> Result<(), AuthorizationServerError> {
        self.with_connection(|tx| tx.record_device_poll(id, polled_at))
    }

    /// See [`GrantTx::record_browser_pairing_poll`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::record_browser_pairing_poll`]'s error.
    fn record_browser_pairing_poll(
        &self,
        id: &str,
        polled_at: DateTime<Utc>,
        browser_name: &str,
    ) -> Result<(), AuthorizationServerError> {
        self.with_connection(|tx| tx.record_browser_pairing_poll(id, polled_at, browser_name))
    }

    /// See [`GrantTx::redeem_authorization_code`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::redeem_authorization_code`]'s error.
    fn redeem_authorization_code(
        &self,
        code: &str,
    ) -> Result<Option<IssuedAuthorizationCode>, AuthorizationServerError> {
        self.with_connection(|tx| tx.redeem_authorization_code(code))
    }

    /// See [`GrantTx::authorization_code_by_request_id`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::authorization_code_by_request_id`]'s error.
    fn authorization_code_by_request_id(
        &self,
        request_id: &str,
    ) -> Result<Option<IssuedAuthorizationCode>, AuthorizationServerError> {
        self.with_connection(|tx| tx.authorization_code_by_request_id(request_id))
    }

    /// See [`GrantTx::issue_authorization_code`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::issue_authorization_code`]'s error.
    fn issue_authorization_code(
        &self,
        code: &IssuedAuthorizationCode,
    ) -> Result<(), AuthorizationServerError> {
        self.with_connection(|tx| tx.issue_authorization_code(code))
    }

    /// See [`GrantTx::insert_browser_session`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::insert_browser_session`]'s error.
    fn insert_browser_session(
        &self,
        session: &BrowserSession,
    ) -> Result<(), AuthorizationServerError> {
        self.with_connection(|tx| tx.insert_browser_session(session))
    }

    /// See [`GrantTx::browser_session_by_sid`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::browser_session_by_sid`]'s error.
    fn browser_session_by_sid(
        &self,
        sid: &str,
    ) -> Result<Option<BrowserSession>, AuthorizationServerError> {
        self.with_connection(|tx| tx.browser_session_by_sid(sid))
    }

    /// See [`GrantTx::live_browser_sessions`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::live_browser_sessions`]'s error.
    fn live_browser_sessions(
        &self,
        now: DateTime<Utc>,
    ) -> Result<Vec<BrowserSession>, AuthorizationServerError> {
        self.with_connection(|tx| tx.live_browser_sessions(now))
    }

    /// See [`GrantTx::browser_session_is_revoked`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::browser_session_is_revoked`]'s error.
    fn browser_session_is_revoked(&self, sid: &str) -> Result<bool, AuthorizationServerError> {
        self.with_connection(|tx| tx.browser_session_is_revoked(sid))
    }

    /// See [`GrantTx::revoke_browser_session`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::revoke_browser_session`]'s error.
    fn revoke_browser_session(
        &self,
        sid: &str,
        now: DateTime<Utc>,
    ) -> Result<bool, AuthorizationServerError> {
        self.with_connection(|tx| tx.revoke_browser_session(sid, now))
    }

    /// See [`GrantTx::touch_browser_session_last_seen`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::touch_browser_session_last_seen`]'s error.
    fn touch_browser_session_last_seen(
        &self,
        sid: &str,
        seen_at: DateTime<Utc>,
        seen_before: DateTime<Utc>,
    ) -> Result<bool, AuthorizationServerError> {
        self.with_connection(|tx| tx.touch_browser_session_last_seen(sid, seen_at, seen_before))
    }

    /// See [`GrantTx::insert_refresh_token_family_row`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::insert_refresh_token_family_row`]'s error.
    fn insert_refresh_token_family_row(
        &self,
        family: &RefreshTokenFamily,
    ) -> Result<(), AuthorizationServerError> {
        self.with_connection(|tx| tx.insert_refresh_token_family_row(family))
    }

    /// See [`GrantTx::insert_refresh_token`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::insert_refresh_token`]'s error.
    fn insert_refresh_token(&self, token: &RefreshToken) -> Result<(), AuthorizationServerError> {
        self.with_connection(|tx| tx.insert_refresh_token(token))
    }

    /// See [`GrantTx::refresh_token_with_family_by_hash`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::refresh_token_with_family_by_hash`]'s error.
    fn refresh_token_with_family_by_hash(
        &self,
        token_hash: &str,
    ) -> Result<Option<(RefreshToken, RefreshTokenFamily)>, AuthorizationServerError> {
        self.with_connection(|tx| tx.refresh_token_with_family_by_hash(token_hash))
    }

    /// See [`GrantTx::expire_refresh_token_family`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::expire_refresh_token_family`]'s error.
    fn expire_refresh_token_family(
        &self,
        family_id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), AuthorizationServerError> {
        self.with_connection(|tx| tx.expire_refresh_token_family(family_id, now))
    }

    /// See [`GrantTx::expire_refresh_token_families_for_authorization_code`].
    ///
    /// # Errors
    ///
    /// Propagates
    /// [`GrantTx::expire_refresh_token_families_for_authorization_code`]'s
    /// error.
    fn expire_refresh_token_families_for_authorization_code(
        &self,
        authorization_code_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<(), AuthorizationServerError> {
        self.with_connection(|tx| {
            tx.expire_refresh_token_families_for_authorization_code(authorization_code_hash, now)
        })
    }

    /// See [`GrantTx::all_grants`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::all_grants`]'s error.
    fn all_grants(&self) -> Result<Vec<Grant>, AuthorizationServerError> {
        self.with_connection(|tx| tx.all_grants())
    }

    /// See [`GrantTx::grant_by_id`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::grant_by_id`]'s error.
    fn grant_by_id(&self, id: &str) -> Result<Option<Grant>, AuthorizationServerError> {
        self.with_connection(|tx| tx.grant_by_id(id))
    }

    /// See [`GrantTx::grant_by_client_and_redirect`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::grant_by_client_and_redirect`]'s error.
    fn grant_by_client_and_redirect(
        &self,
        client_id: &str,
        redirect_uri: &Url,
    ) -> Result<Option<AuthorizationCodeGrant>, AuthorizationServerError> {
        self.with_connection(|tx| tx.grant_by_client_and_redirect(client_id, redirect_uri))
    }

    /// See [`GrantTx::device_grant_by_client_and_device_name`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::device_grant_by_client_and_device_name`]'s
    /// error.
    fn device_grant_by_client_and_device_name(
        &self,
        client_id: &str,
        device_name: &str,
    ) -> Result<Option<DeviceGrant>, AuthorizationServerError> {
        self.with_connection(|tx| tx.device_grant_by_client_and_device_name(client_id, device_name))
    }

    /// See [`GrantTx::create_authorization_code_grant`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::create_authorization_code_grant`]'s error.
    fn create_authorization_code_grant(
        &self,
        grant: &AuthorizationCodeGrant,
    ) -> Result<(), AuthorizationServerError> {
        self.with_connection(|tx| tx.create_authorization_code_grant(grant))
    }

    /// See [`GrantTx::create_device_grant`].
    ///
    /// # Errors
    ///
    /// Propagates [`GrantTx::create_device_grant`]'s error.
    fn create_device_grant(&self, grant: &DeviceGrant) -> Result<(), AuthorizationServerError> {
        self.with_connection(|tx| tx.create_device_grant(grant))
    }
}
