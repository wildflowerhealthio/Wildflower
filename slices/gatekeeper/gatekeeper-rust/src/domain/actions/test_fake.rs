//! The in-memory [`FakeGatekeeperStore`] and the request/grant fixtures the
//! per-entity action tests share. Modelling the primitive port semantics with no
//! diesel and no database is enough to exercise the actions' semantic mapping (the
//! `*NotFound` decisions, the consent-loader validation, and now the composed
//! transaction scripts — grant upserts, the three-state consume, revoke). The
//! primitives live on [`FakeGatekeeperTx`] (the fake's [`GatekeeperTx`]); the
//! [`GatekeeperStore`] seam hands one out and, for
//! [`transaction`](GatekeeperStore::transaction) /
//! [`immediate_transaction`](GatekeeperStore::immediate_transaction), snapshots
//! the maps up front and restores them if the closure returns `Err`, so a failed
//! composed action rolls back exactly as diesel would. The `SQLite` adapter's own
//! SQL-level coverage (and its real lock semantics) live in `crate::db`, so the
//! operations the semantic tests never reach are simple in-memory stand-ins
//! rather than faithful SQL replicas.

use std::cell::RefCell;
use std::collections::HashMap;

use chrono::{DateTime, Duration, Utc};
use url::Url;

use crate::domain::authorization_code::AuthorizationCode;
use crate::domain::authorization_request::{AuthorizationRequest, GrantType, RequestStatus};
use crate::domain::client::{AllowedGrantType, Client, ClientKind};
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::grant::{AuthorizationCodeGrant, DeviceGrant, Grant};
use crate::domain::refresh_token::{RefreshToken, RefreshTokenFamily};
use crate::domain::signing_key::SigningKey;
use crate::domain::{GatekeeperStore, GatekeeperTx};

/// An in-memory [`GatekeeperStore`] modelling the primitive port semantics with
/// no diesel and no database — enough to exercise the actions' semantic mapping
/// and their composed transaction scripts.
#[derive(Default)]
pub(crate) struct FakeGatekeeperStore {
    clients: RefCell<HashMap<String, Client>>,
    signing_keys: RefCell<Vec<SigningKey>>,
    authorization_requests: RefCell<HashMap<String, AuthorizationRequest>>,
    authorization_codes: RefCell<HashMap<String, AuthorizationCode>>,
    families: RefCell<HashMap<String, RefreshTokenFamily>>,
    tokens: RefCell<HashMap<String, RefreshToken>>,
    code_grants: RefCell<HashMap<String, AuthorizationCodeGrant>>,
    device_grants: RefCell<HashMap<String, DeviceGrant>>,
}

/// A clone of every map, taken before a transaction runs so it can be restored
/// on rollback.
struct Snapshot {
    clients: HashMap<String, Client>,
    signing_keys: Vec<SigningKey>,
    authorization_requests: HashMap<String, AuthorizationRequest>,
    authorization_codes: HashMap<String, AuthorizationCode>,
    families: HashMap<String, RefreshTokenFamily>,
    tokens: HashMap<String, RefreshToken>,
    code_grants: HashMap<String, AuthorizationCodeGrant>,
    device_grants: HashMap<String, DeviceGrant>,
}

impl FakeGatekeeperStore {
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            clients: self.clients.borrow().clone(),
            signing_keys: self.signing_keys.borrow().clone(),
            authorization_requests: self.authorization_requests.borrow().clone(),
            authorization_codes: self.authorization_codes.borrow().clone(),
            families: self.families.borrow().clone(),
            tokens: self.tokens.borrow().clone(),
            code_grants: self.code_grants.borrow().clone(),
            device_grants: self.device_grants.borrow().clone(),
        }
    }

    fn restore(&self, snapshot: Snapshot) {
        *self.clients.borrow_mut() = snapshot.clients;
        *self.signing_keys.borrow_mut() = snapshot.signing_keys;
        *self.authorization_requests.borrow_mut() = snapshot.authorization_requests;
        *self.authorization_codes.borrow_mut() = snapshot.authorization_codes;
        *self.families.borrow_mut() = snapshot.families;
        *self.tokens.borrow_mut() = snapshot.tokens;
        *self.code_grants.borrow_mut() = snapshot.code_grants;
        *self.device_grants.borrow_mut() = snapshot.device_grants;
    }
}

impl GatekeeperStore for FakeGatekeeperStore {
    type Tx<'a> = FakeGatekeeperTx<'a>;

    fn with_connection<T>(
        &self,
        f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T, GatekeeperError>,
    ) -> Result<T, GatekeeperError> {
        f(&mut FakeGatekeeperTx { store: self })
    }

    fn transaction<T>(
        &self,
        f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T, GatekeeperError>,
    ) -> Result<T, GatekeeperError> {
        // No real locking (the fake is single-threaded); the snapshot models the
        // one property the composed actions rely on — rollback on error — so a
        // partially-applied transaction never leaks into a later assertion.
        let snapshot = self.snapshot();
        let result = f(&mut FakeGatekeeperTx { store: self });
        if result.is_err() {
            self.restore(snapshot);
        }
        result
    }

    fn immediate_transaction<T>(
        &self,
        f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T, GatekeeperError>,
    ) -> Result<T, GatekeeperError> {
        self.transaction(f)
    }
}

/// The fake's [`GatekeeperTx`] — a borrow of the store's maps. Interior
/// mutability (`RefCell`) does the real work; `&mut self` is only the trait's
/// shape.
pub(crate) struct FakeGatekeeperTx<'a> {
    store: &'a FakeGatekeeperStore,
}

impl GatekeeperTx for FakeGatekeeperTx<'_> {
    fn client_by_id(&mut self, client_id: &str) -> Result<Option<Client>, GatekeeperError> {
        Ok(self.store.clients.borrow().get(client_id).cloned())
    }

    fn upsert_client(&mut self, client: &Client) -> Result<(), GatekeeperError> {
        self.store
            .clients
            .borrow_mut()
            .insert(client.client_id.clone(), client.clone());
        Ok(())
    }

    fn all_signing_keys(&mut self) -> Result<Vec<SigningKey>, GatekeeperError> {
        Ok(self.store.signing_keys.borrow().clone())
    }

    fn active_signing_key(&mut self) -> Result<Option<SigningKey>, GatekeeperError> {
        Ok(self
            .store
            .signing_keys
            .borrow()
            .iter()
            .find(|k| k.is_active)
            .cloned())
    }

    fn has_active_signing_key(&mut self) -> Result<bool, GatekeeperError> {
        Ok(self.store.signing_keys.borrow().iter().any(|k| k.is_active))
    }

    fn insert_signing_key(&mut self, key: &SigningKey) -> Result<(), GatekeeperError> {
        self.store.signing_keys.borrow_mut().push(key.clone());
        Ok(())
    }

    fn authorization_request_by_id(
        &mut self,
        id: &str,
    ) -> Result<Option<AuthorizationRequest>, GatekeeperError> {
        Ok(self.store.authorization_requests.borrow().get(id).cloned())
    }

    fn authorization_request_by_user_code(
        &mut self,
        user_code: &str,
    ) -> Result<Option<AuthorizationRequest>, GatekeeperError> {
        Ok(self
            .store
            .authorization_requests
            .borrow()
            .values()
            .find(|r| r.user_code.as_deref() == Some(user_code))
            .cloned())
    }

    fn pending_authorization_request_by_user_code(
        &mut self,
        user_code: &str,
    ) -> Result<Option<AuthorizationRequest>, GatekeeperError> {
        Ok(self
            .store
            .authorization_requests
            .borrow()
            .values()
            .find(|r| {
                r.user_code.as_deref() == Some(user_code) && r.status == RequestStatus::Pending
            })
            .cloned())
    }

    fn oldest_pending_device_user_code(&mut self) -> Result<Option<String>, GatekeeperError> {
        let requests = self.store.authorization_requests.borrow();
        let mut pending: Vec<&AuthorizationRequest> = requests
            .values()
            .filter(|r| {
                r.grant_type == GrantType::DeviceCode
                    && r.status == RequestStatus::Pending
                    && r.user_code.is_some()
                    && r.expires_at > Utc::now()
            })
            .collect();
        pending.sort_by_key(|r| r.requested_at);
        Ok(pending.first().and_then(|r| r.user_code.clone()))
    }

    fn insert_authorization_request(
        &mut self,
        request: &AuthorizationRequest,
    ) -> Result<(), GatekeeperError> {
        self.store
            .authorization_requests
            .borrow_mut()
            .insert(request.id.clone(), request.clone());
        Ok(())
    }

    fn approve_authorization_request(
        &mut self,
        id: &str,
        granted_scopes: &[String],
        patient: Option<&str>,
        device_name: Option<&str>,
    ) -> Result<bool, GatekeeperError> {
        let mut requests = self.store.authorization_requests.borrow_mut();
        let Some(request) = requests.get_mut(id) else {
            return Ok(false);
        };
        if request.status != RequestStatus::Pending {
            return Ok(false);
        }
        request.status = RequestStatus::Approved;
        request.granted_scopes = Some(granted_scopes.to_vec());
        request.patient = patient.map(str::to_owned);
        if let Some(name) = device_name {
            request.device_name = Some(name.to_owned());
        }
        Ok(true)
    }

    fn deny_authorization_request(&mut self, id: &str) -> Result<(), GatekeeperError> {
        if let Some(request) = self.store.authorization_requests.borrow_mut().get_mut(id) {
            request.status = RequestStatus::Denied;
        }
        Ok(())
    }

    fn consume_approved_authorization_request(
        &mut self,
        id: &str,
    ) -> Result<bool, GatekeeperError> {
        let mut requests = self.store.authorization_requests.borrow_mut();
        let Some(request) = requests.get_mut(id) else {
            return Ok(false);
        };
        if request.status != RequestStatus::Approved {
            return Ok(false);
        }
        request.status = RequestStatus::Expired;
        Ok(true)
    }

    fn record_device_poll(
        &mut self,
        id: &str,
        polled_at: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        if let Some(request) = self.store.authorization_requests.borrow_mut().get_mut(id) {
            request.last_polled_at = Some(polled_at);
        }
        Ok(())
    }

    fn redeem_authorization_code(
        &mut self,
        code: &str,
    ) -> Result<Option<AuthorizationCode>, GatekeeperError> {
        Ok(self.store.authorization_codes.borrow_mut().remove(code))
    }

    fn authorization_code_by_request_id(
        &mut self,
        request_id: &str,
    ) -> Result<Option<AuthorizationCode>, GatekeeperError> {
        Ok(self
            .store
            .authorization_codes
            .borrow()
            .values()
            .find(|c| c.request_id == request_id)
            .cloned())
    }

    fn issue_authorization_code(
        &mut self,
        code: &AuthorizationCode,
    ) -> Result<(), GatekeeperError> {
        self.store
            .authorization_codes
            .borrow_mut()
            .insert(code.code.clone(), code.clone());
        Ok(())
    }

    fn insert_refresh_token_family_row(
        &mut self,
        family: &RefreshTokenFamily,
    ) -> Result<(), GatekeeperError> {
        self.store
            .families
            .borrow_mut()
            .insert(family.family_id.clone(), family.clone());
        Ok(())
    }

    fn insert_refresh_token(&mut self, token: &RefreshToken) -> Result<(), GatekeeperError> {
        self.store
            .tokens
            .borrow_mut()
            .insert(token.token_hash.clone(), token.clone());
        Ok(())
    }

    fn refresh_token_with_family_by_hash(
        &mut self,
        token_hash: &str,
    ) -> Result<Option<(RefreshToken, RefreshTokenFamily)>, GatekeeperError> {
        let tokens = self.store.tokens.borrow();
        let Some(token) = tokens.get(token_hash) else {
            return Ok(None);
        };
        let families = self.store.families.borrow();
        Ok(families
            .get(&token.family_id)
            .map(|family| (token.clone(), family.clone())))
    }

    fn stamp_refresh_token_consumed_if_live(
        &mut self,
        token_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<bool, GatekeeperError> {
        let mut tokens = self.store.tokens.borrow_mut();
        match tokens.get_mut(token_hash) {
            Some(token) if token.consumed_at.is_none() => {
                token.consumed_at = Some(now);
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    fn refresh_token_exists(&mut self, token_hash: &str) -> Result<bool, GatekeeperError> {
        Ok(self.store.tokens.borrow().contains_key(token_hash))
    }

    fn expire_refresh_token_family(
        &mut self,
        family_id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        if let Some(family) = self.store.families.borrow_mut().get_mut(family_id) {
            family.expires_at = now;
        }
        for token in self.store.tokens.borrow_mut().values_mut() {
            if token.family_id == family_id && token.consumed_at.is_none() {
                token.consumed_at = Some(now);
            }
        }
        Ok(())
    }

    fn expire_refresh_token_families_for_client(
        &mut self,
        client_id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        let family_ids: Vec<String> = self
            .store
            .families
            .borrow()
            .values()
            .filter(|f| f.client_id == client_id)
            .map(|f| f.family_id.clone())
            .collect();
        for family_id in family_ids {
            self.expire_refresh_token_family(&family_id, now)?;
        }
        Ok(())
    }

    fn expire_refresh_token_families_for_authorization_code(
        &mut self,
        authorization_code_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        let family_ids: Vec<String> = self
            .store
            .families
            .borrow()
            .values()
            .filter(|f| f.authorization_code_hash.as_deref() == Some(authorization_code_hash))
            .map(|f| f.family_id.clone())
            .collect();
        for family_id in family_ids {
            self.expire_refresh_token_family(&family_id, now)?;
        }
        Ok(())
    }

    fn all_grants(&mut self) -> Result<Vec<Grant>, GatekeeperError> {
        let mut grants: Vec<Grant> = self
            .store
            .code_grants
            .borrow()
            .values()
            .cloned()
            .map(Grant::AuthorizationCode)
            .chain(
                self.store
                    .device_grants
                    .borrow()
                    .values()
                    .cloned()
                    .map(Grant::DeviceCode),
            )
            .collect();
        grants.sort_by_key(|g| g.id().to_owned());
        Ok(grants)
    }

    fn grant_by_id(&mut self, id: &str) -> Result<Option<Grant>, GatekeeperError> {
        if let Some(grant) = self.store.code_grants.borrow().get(id) {
            return Ok(Some(Grant::AuthorizationCode(grant.clone())));
        }
        Ok(self
            .store
            .device_grants
            .borrow()
            .get(id)
            .cloned()
            .map(Grant::DeviceCode))
    }

    fn grant_by_client_and_redirect(
        &mut self,
        client_id: &str,
        redirect_uri: &Url,
    ) -> Result<Option<AuthorizationCodeGrant>, GatekeeperError> {
        Ok(self
            .store
            .code_grants
            .borrow()
            .values()
            .find(|g| g.client_id == client_id && &g.redirect_uri == redirect_uri)
            .cloned())
    }

    fn device_grant_by_client_and_device_name(
        &mut self,
        client_id: &str,
        device_name: &str,
    ) -> Result<Option<DeviceGrant>, GatekeeperError> {
        Ok(self
            .store
            .device_grants
            .borrow()
            .values()
            .find(|g| g.client_id == client_id && g.device_name == device_name)
            .cloned())
    }

    fn create_authorization_code_grant(
        &mut self,
        grant: &AuthorizationCodeGrant,
    ) -> Result<(), GatekeeperError> {
        self.store
            .code_grants
            .borrow_mut()
            .insert(grant.id.clone(), grant.clone());
        Ok(())
    }

    fn create_device_grant(&mut self, grant: &DeviceGrant) -> Result<(), GatekeeperError> {
        self.store
            .device_grants
            .borrow_mut()
            .insert(grant.id.clone(), grant.clone());
        Ok(())
    }

    fn update_authorization_code_grant(
        &mut self,
        grant: &AuthorizationCodeGrant,
    ) -> Result<(), GatekeeperError> {
        self.store
            .code_grants
            .borrow_mut()
            .insert(grant.id.clone(), grant.clone());
        Ok(())
    }

    fn update_device_grant(&mut self, grant: &DeviceGrant) -> Result<(), GatekeeperError> {
        self.store
            .device_grants
            .borrow_mut()
            .insert(grant.id.clone(), grant.clone());
        Ok(())
    }

    fn delete_authorization_code_grant(&mut self, id: &str) -> Result<bool, GatekeeperError> {
        Ok(self.store.code_grants.borrow_mut().remove(id).is_some())
    }

    fn delete_device_grant(&mut self, id: &str) -> Result<bool, GatekeeperError> {
        Ok(self.store.device_grants.borrow_mut().remove(id).is_some())
    }
}

/// A pending (by default) device-code authorization request fixture.
pub(crate) fn device_request(
    id: &str,
    user_code: &str,
    status: RequestStatus,
) -> AuthorizationRequest {
    let now = Utc::now();
    AuthorizationRequest {
        id: id.to_owned(),
        grant_type: GrantType::DeviceCode,
        client_id: "client".to_owned(),
        requested_scopes: vec!["openid".to_owned()],
        code_challenge: None,
        code_challenge_method: None,
        redirect_uri: None,
        client_state: None,
        user_code: Some(user_code.to_owned()),
        pre_approved_scopes: Vec::new(),
        requested_at: now,
        expires_at: now + Duration::minutes(5),
        last_polled_at: None,
        status,
        granted_scopes: None,
        patient: None,
        device_name: None,
    }
}

/// A well-formed authorization-code request fixture (populated `redirect_uri` +
/// PKCE `code_challenge`) with a caller-chosen `status` and `expires_at`.
pub(crate) fn code_request(
    id: &str,
    status: RequestStatus,
    expires_at: DateTime<Utc>,
) -> AuthorizationRequest {
    AuthorizationRequest {
        id: id.to_owned(),
        grant_type: GrantType::AuthorizationCode,
        client_id: "client".to_owned(),
        requested_scopes: vec!["read".to_owned()],
        code_challenge: Some("c".repeat(43)),
        code_challenge_method: Some("S256".to_owned()),
        redirect_uri: Some(Url::parse("https://example.com/cb").unwrap()),
        client_state: Some("state".to_owned()),
        user_code: None,
        pre_approved_scopes: Vec::new(),
        requested_at: Utc::now(),
        expires_at,
        last_polled_at: None,
        status,
        granted_scopes: None,
        patient: None,
        device_name: None,
    }
}

/// A public-client fixture with a caller-chosen `allowed_scopes` set and the
/// `https://example.com/cb` redirect the request fixtures use.
pub(crate) fn client(client_id: &str, allowed_scopes: &[&str]) -> Client {
    Client {
        client_id: client_id.to_owned(),
        name: format!("{client_id} display name"),
        kind: ClientKind::Public,
        redirect_uris: vec![Url::parse("https://example.com/cb").unwrap()],
        allowed_scopes: allowed_scopes.iter().map(|s| (*s).to_owned()).collect(),
        allowed_grant_types: AllowedGrantType::ALL.to_vec(),
        secret_hash: None,
        registered_at: Utc::now(),
        disabled_at: None,
    }
}

/// An authorization-code grant fixture.
pub(crate) fn code_grant(id: &str, client_id: &str) -> AuthorizationCodeGrant {
    AuthorizationCodeGrant {
        id: id.to_owned(),
        client_id: client_id.to_owned(),
        scopes: vec!["read".to_owned()],
        granted_at: Utc::now(),
        last_used_at: None,
        patient: None,
        redirect_uri: Url::parse("https://example.com/cb").unwrap(),
    }
}
