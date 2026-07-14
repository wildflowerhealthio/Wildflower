//! The in-memory [`FakeGatekeeperStore`] and the request/grant fixtures the
//! per-entity action tests share. Modelling the primitive port semantics with no
//! diesel and no database is enough to exercise the actions' semantic mapping (the
//! `*NotFound` decisions and the consent-loader validation); the `SQLite` adapter's
//! own SQL-level coverage lives in `crate::db`, so the store operations the semantic
//! tests never reach are simple in-memory stand-ins rather than faithful SQL
//! replicas.

use std::cell::RefCell;
use std::collections::HashMap;

use chrono::{DateTime, Duration, Utc};
use url::Url;

use crate::domain::authorization_code::AuthorizationCode;
use crate::domain::authorization_request::{AuthorizationRequest, GrantType, RequestStatus};
use crate::domain::client::Client;
use crate::domain::error::GatekeeperError;
use crate::domain::grant::{AuthorizationCodeGrant, DeviceGrant, Grant};
use crate::domain::refresh_token::{RefreshToken, RefreshTokenConsumeOutcome, RefreshTokenFamily};
use crate::domain::signing_key::SigningKey;
use crate::domain::GatekeeperStore;

/// An in-memory [`GatekeeperStore`] modelling the primitive port semantics with
/// no diesel and no database — enough to exercise the actions' semantic mapping.
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

impl GatekeeperStore for FakeGatekeeperStore {
    fn client_by_id(&self, client_id: &str) -> Result<Option<Client>, GatekeeperError> {
        Ok(self.clients.borrow().get(client_id).cloned())
    }

    fn register_client(&self, client: &Client) -> Result<(), GatekeeperError> {
        self.clients
            .borrow_mut()
            .insert(client.client_id.clone(), client.clone());
        Ok(())
    }

    fn upsert_client(&self, client: &Client) -> Result<(), GatekeeperError> {
        self.register_client(client)
    }

    fn all_signing_keys(&self) -> Result<Vec<SigningKey>, GatekeeperError> {
        Ok(self.signing_keys.borrow().clone())
    }

    fn active_signing_key(&self) -> Result<Option<SigningKey>, GatekeeperError> {
        Ok(self
            .signing_keys
            .borrow()
            .iter()
            .find(|k| k.is_active)
            .cloned())
    }

    fn has_active_signing_key(&self) -> Result<bool, GatekeeperError> {
        Ok(self.signing_keys.borrow().iter().any(|k| k.is_active))
    }

    fn insert_signing_key(&self, key: &SigningKey) -> Result<(), GatekeeperError> {
        self.signing_keys.borrow_mut().push(key.clone());
        Ok(())
    }

    fn authorization_request_by_id(
        &self,
        id: &str,
    ) -> Result<Option<AuthorizationRequest>, GatekeeperError> {
        Ok(self.authorization_requests.borrow().get(id).cloned())
    }

    fn authorization_request_by_user_code(
        &self,
        user_code: &str,
    ) -> Result<Option<AuthorizationRequest>, GatekeeperError> {
        Ok(self
            .authorization_requests
            .borrow()
            .values()
            .find(|r| r.user_code.as_deref() == Some(user_code))
            .cloned())
    }

    fn pending_authorization_request_by_user_code(
        &self,
        user_code: &str,
    ) -> Result<Option<AuthorizationRequest>, GatekeeperError> {
        Ok(self
            .authorization_requests
            .borrow()
            .values()
            .find(|r| {
                r.user_code.as_deref() == Some(user_code) && r.status == RequestStatus::Pending
            })
            .cloned())
    }

    fn oldest_pending_device_user_code(&self) -> Result<Option<String>, GatekeeperError> {
        let requests = self.authorization_requests.borrow();
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
        &self,
        request: &AuthorizationRequest,
    ) -> Result<(), GatekeeperError> {
        self.authorization_requests
            .borrow_mut()
            .insert(request.id.clone(), request.clone());
        Ok(())
    }

    fn approve_authorization_request(
        &self,
        id: &str,
        granted_scopes: &[String],
        patient: Option<&str>,
        device_name: Option<&str>,
    ) -> Result<bool, GatekeeperError> {
        let mut requests = self.authorization_requests.borrow_mut();
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

    fn deny_authorization_request(&self, id: &str) -> Result<(), GatekeeperError> {
        if let Some(request) = self.authorization_requests.borrow_mut().get_mut(id) {
            request.status = RequestStatus::Denied;
        }
        Ok(())
    }

    fn consume_approved_authorization_request(&self, id: &str) -> Result<bool, GatekeeperError> {
        let mut requests = self.authorization_requests.borrow_mut();
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
        &self,
        id: &str,
        polled_at: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        if let Some(request) = self.authorization_requests.borrow_mut().get_mut(id) {
            request.last_polled_at = Some(polled_at);
        }
        Ok(())
    }

    fn redeem_authorization_code(
        &self,
        code: &str,
    ) -> Result<Option<AuthorizationCode>, GatekeeperError> {
        Ok(self.authorization_codes.borrow_mut().remove(code))
    }

    fn authorization_code_by_request_id(
        &self,
        request_id: &str,
    ) -> Result<Option<AuthorizationCode>, GatekeeperError> {
        Ok(self
            .authorization_codes
            .borrow()
            .values()
            .find(|c| c.request_id == request_id)
            .cloned())
    }

    fn issue_authorization_code(&self, code: &AuthorizationCode) -> Result<(), GatekeeperError> {
        self.authorization_codes
            .borrow_mut()
            .insert(code.code.clone(), code.clone());
        Ok(())
    }

    fn insert_refresh_token_family(
        &self,
        family: &RefreshTokenFamily,
        first_token: &RefreshToken,
    ) -> Result<(), GatekeeperError> {
        self.families
            .borrow_mut()
            .insert(family.family_id.clone(), family.clone());
        self.tokens
            .borrow_mut()
            .insert(first_token.token_hash.clone(), first_token.clone());
        Ok(())
    }

    fn insert_refresh_token(&self, token: &RefreshToken) -> Result<(), GatekeeperError> {
        self.tokens
            .borrow_mut()
            .insert(token.token_hash.clone(), token.clone());
        Ok(())
    }

    fn refresh_token_with_family_by_hash(
        &self,
        token_hash: &str,
    ) -> Result<Option<(RefreshToken, RefreshTokenFamily)>, GatekeeperError> {
        let tokens = self.tokens.borrow();
        let Some(token) = tokens.get(token_hash) else {
            return Ok(None);
        };
        let families = self.families.borrow();
        Ok(families
            .get(&token.family_id)
            .map(|family| (token.clone(), family.clone())))
    }

    fn refresh_token_by_hash(
        &self,
        token_hash: &str,
    ) -> Result<Option<RefreshToken>, GatekeeperError> {
        Ok(self.tokens.borrow().get(token_hash).cloned())
    }

    fn consume_refresh_token(
        &self,
        token_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<RefreshTokenConsumeOutcome, GatekeeperError> {
        let mut tokens = self.tokens.borrow_mut();
        let Some(token) = tokens.get_mut(token_hash) else {
            return Ok(RefreshTokenConsumeOutcome::NotFound);
        };
        if token.consumed_at.is_some() {
            return Ok(RefreshTokenConsumeOutcome::Replayed);
        }
        token.consumed_at = Some(now);
        Ok(RefreshTokenConsumeOutcome::Consumed)
    }

    fn rotate_refresh_token(
        &self,
        presented_hash: &str,
        successor: &RefreshToken,
        now: DateTime<Utc>,
    ) -> Result<RefreshTokenConsumeOutcome, GatekeeperError> {
        let outcome = self.consume_refresh_token(presented_hash, now)?;
        if outcome == RefreshTokenConsumeOutcome::Consumed {
            self.insert_refresh_token(successor)?;
        }
        Ok(outcome)
    }

    fn expire_refresh_token_family(
        &self,
        family_id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        if let Some(family) = self.families.borrow_mut().get_mut(family_id) {
            family.expires_at = now;
        }
        for token in self.tokens.borrow_mut().values_mut() {
            if token.family_id == family_id && token.consumed_at.is_none() {
                token.consumed_at = Some(now);
            }
        }
        Ok(())
    }

    fn expire_refresh_token_families_for_client(
        &self,
        client_id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        let family_ids: Vec<String> = self
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
        &self,
        authorization_code_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        let family_ids: Vec<String> = self
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

    fn all_grants(&self) -> Result<Vec<Grant>, GatekeeperError> {
        let mut grants: Vec<Grant> = self
            .code_grants
            .borrow()
            .values()
            .cloned()
            .map(Grant::AuthorizationCode)
            .chain(
                self.device_grants
                    .borrow()
                    .values()
                    .cloned()
                    .map(Grant::DeviceCode),
            )
            .collect();
        grants.sort_by_key(|g| g.id().to_owned());
        Ok(grants)
    }

    fn grant_by_id(&self, id: &str) -> Result<Option<Grant>, GatekeeperError> {
        if let Some(grant) = self.code_grants.borrow().get(id) {
            return Ok(Some(Grant::AuthorizationCode(grant.clone())));
        }
        Ok(self
            .device_grants
            .borrow()
            .get(id)
            .cloned()
            .map(Grant::DeviceCode))
    }

    fn grant_by_client_and_redirect(
        &self,
        client_id: &str,
        redirect_uri: &Url,
    ) -> Result<Option<AuthorizationCodeGrant>, GatekeeperError> {
        Ok(self
            .code_grants
            .borrow()
            .values()
            .find(|g| g.client_id == client_id && &g.redirect_uri == redirect_uri)
            .cloned())
    }

    fn device_grant_by_client_and_device_name(
        &self,
        client_id: &str,
        device_name: &str,
    ) -> Result<Option<DeviceGrant>, GatekeeperError> {
        Ok(self
            .device_grants
            .borrow()
            .values()
            .find(|g| g.client_id == client_id && g.device_name == device_name)
            .cloned())
    }

    fn create_authorization_code_grant(
        &self,
        grant: &AuthorizationCodeGrant,
    ) -> Result<(), GatekeeperError> {
        self.code_grants
            .borrow_mut()
            .insert(grant.id.clone(), grant.clone());
        Ok(())
    }

    fn create_device_grant(&self, grant: &DeviceGrant) -> Result<(), GatekeeperError> {
        self.device_grants
            .borrow_mut()
            .insert(grant.id.clone(), grant.clone());
        Ok(())
    }

    fn upsert_authorization_code_grant(
        &self,
        client_id: &str,
        redirect_uri: &Url,
        scopes: &[String],
        patient: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        let existing_id = self
            .code_grants
            .borrow()
            .values()
            .find(|g| g.client_id == client_id && &g.redirect_uri == redirect_uri)
            .map(|g| g.id.clone());
        let id = existing_id.unwrap_or_else(|| format!("code-grant-{client_id}"));
        self.code_grants.borrow_mut().insert(
            id.clone(),
            AuthorizationCodeGrant {
                id,
                client_id: client_id.to_owned(),
                scopes: scopes.to_vec(),
                granted_at: now,
                last_used_at: None,
                patient: patient.map(str::to_owned),
                redirect_uri: redirect_uri.clone(),
            },
        );
        Ok(())
    }

    fn upsert_device_grant(
        &self,
        client_id: &str,
        device_name: &str,
        scopes: &[String],
        patient: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        let id = format!("device-grant-{client_id}-{device_name}");
        self.device_grants.borrow_mut().insert(
            id.clone(),
            DeviceGrant {
                id,
                client_id: client_id.to_owned(),
                scopes: scopes.to_vec(),
                granted_at: now,
                last_used_at: None,
                patient: patient.map(str::to_owned),
                device_name: device_name.to_owned(),
            },
        );
        Ok(())
    }

    fn revoke_grant_and_expire_client_families(
        &self,
        grant_id: &str,
        client_id: &str,
        now: DateTime<Utc>,
    ) -> Result<bool, GatekeeperError> {
        let removed = self.code_grants.borrow_mut().remove(grant_id).is_some()
            || self.device_grants.borrow_mut().remove(grant_id).is_some();
        self.expire_refresh_token_families_for_client(client_id, now)?;
        Ok(removed)
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
