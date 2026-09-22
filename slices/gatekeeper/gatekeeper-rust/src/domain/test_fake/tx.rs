//! The fake's [`GatekeeperTx`] implementation — every primitive over the store's
//! in-memory maps.

use chrono::{DateTime, Utc};
use url::Url;

use super::FakeGatekeeperTx;
use crate::domain::authorization_code::IssuedAuthorizationCode;
use crate::domain::authorization_request::{AuthorizationRequest, GrantType, RequestStatus};
use crate::domain::client::Client;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::grant::{AuthorizationCodeGrant, DeviceGrant, Grant};
use crate::domain::pending_consent::PendingConsentHead;
use crate::domain::refresh_token::{RefreshToken, RefreshTokenFamily};
use crate::domain::signing_key::SigningKey;
use crate::domain::GatekeeperTx;

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

    fn oldest_pending_consent_head(
        &mut self,
    ) -> Result<Option<PendingConsentHead>, GatekeeperError> {
        let requests = self.store.authorization_requests.borrow();
        let mut pending: Vec<&AuthorizationRequest> = requests
            .values()
            .filter(|r| r.status == RequestStatus::Pending && r.expires_at > Utc::now())
            .filter(|r| match r.grant_type {
                GrantType::AuthorizationCode => true,
                // Mirrors the SQL guard: a device row without its `user_code`
                // has no key the consent surface could fetch by, so it is not a
                // candidate head rather than a head with a missing key.
                GrantType::DeviceCode => r.user_code.is_some(),
            })
            .collect();
        pending.sort_by_key(|r| r.requested_at);
        Ok(pending.first().and_then(|r| match r.grant_type {
            GrantType::AuthorizationCode => Some(PendingConsentHead::OAuth { id: r.id.clone() }),
            GrantType::DeviceCode => r
                .user_code
                .clone()
                .map(|user_code| PendingConsentHead::Device { user_code }),
        }))
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
    ) -> Result<Option<IssuedAuthorizationCode>, GatekeeperError> {
        Ok(self.store.authorization_codes.borrow_mut().remove(code))
    }

    fn authorization_code_by_request_id(
        &mut self,
        request_id: &str,
    ) -> Result<Option<IssuedAuthorizationCode>, GatekeeperError> {
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
        code: &IssuedAuthorizationCode,
    ) -> Result<(), GatekeeperError> {
        self.store
            .authorization_codes
            .borrow_mut()
            .insert(code.code.clone(), code.clone());
        Ok(())
    }

    fn delete_authorization_requests_expired_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, GatekeeperError> {
        let mut requests = self.store.authorization_requests.borrow_mut();
        let before = requests.len();
        requests.retain(|_, r| r.expires_at >= cutoff);
        Ok(before - requests.len())
    }

    fn delete_authorization_codes_expired_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, GatekeeperError> {
        let mut codes = self.store.authorization_codes.borrow_mut();
        let before = codes.len();
        codes.retain(|_, c| c.expires_at >= cutoff);
        Ok(before - codes.len())
    }

    fn delete_refresh_token_families_expired_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, GatekeeperError> {
        // Children first, mirroring the FK order the SQL body has to observe —
        // the fake has no foreign keys, but a test that asserts on the token map
        // should see the same intermediate shape.
        let doomed: Vec<String> = self
            .store
            .families
            .borrow()
            .values()
            .filter(|f| f.expires_at < cutoff)
            .map(|f| f.family_id.clone())
            .collect();
        self.store
            .tokens
            .borrow_mut()
            .retain(|_, t| !doomed.contains(&t.family_id));
        self.store
            .families
            .borrow_mut()
            .retain(|_, f| f.expires_at >= cutoff);
        Ok(doomed.len())
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
