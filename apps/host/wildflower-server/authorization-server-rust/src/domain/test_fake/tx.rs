//! The fake's [`GrantTx`] implementation — every primitive over the store's
//! in-memory maps.

use chrono::{DateTime, Utc};
use url::Url;

use super::FakeGrantTx;
use crate::domain::authorization_code::IssuedAuthorizationCode;
use crate::domain::authorization_request::{AuthorizationRequest, GrantType, RequestStatus};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::browser_session::BrowserSession;
use crate::domain::client::Client;
use crate::domain::grant::{AuthorizationCodeGrant, DeviceGrant, Grant};
use crate::domain::launch_context::LaunchContext;
use crate::domain::pending_consent::NewestPendingConsent;
use crate::domain::refresh_token::{RefreshToken, RefreshTokenFamily};
use crate::domain::signing_key::SigningKey;
use crate::domain::GrantTx;

impl GrantTx for FakeGrantTx<'_> {
    fn client_by_id(
        &mut self,
        client_id: &str,
    ) -> Result<Option<Client>, AuthorizationServerError> {
        Ok(self.store.clients.borrow().get(client_id).cloned())
    }

    fn upsert_client(&mut self, client: &Client) -> Result<(), AuthorizationServerError> {
        self.store
            .clients
            .borrow_mut()
            .insert(client.client_id.clone(), client.clone());
        Ok(())
    }

    fn list_clients(&mut self) -> Result<Vec<Client>, AuthorizationServerError> {
        let mut clients: Vec<Client> = self.store.clients.borrow().values().cloned().collect();
        clients.sort_by(|a, b| a.client_id.cmp(&b.client_id));
        Ok(clients)
    }

    fn set_client_disabled(
        &mut self,
        client_id: &str,
        disabled_at: Option<DateTime<Utc>>,
    ) -> Result<bool, AuthorizationServerError> {
        Ok(self
            .store
            .clients
            .borrow_mut()
            .get_mut(client_id)
            .map(|client| client.disabled_at = disabled_at)
            .is_some())
    }

    fn all_signing_keys(&mut self) -> Result<Vec<SigningKey>, AuthorizationServerError> {
        Ok(self.store.signing_keys.borrow().clone())
    }

    fn active_signing_key(&mut self) -> Result<Option<SigningKey>, AuthorizationServerError> {
        Ok(self
            .store
            .signing_keys
            .borrow()
            .iter()
            .find(|k| k.is_active)
            .cloned())
    }

    fn has_active_signing_key(&mut self) -> Result<bool, AuthorizationServerError> {
        Ok(self.store.signing_keys.borrow().iter().any(|k| k.is_active))
    }

    fn insert_signing_key(&mut self, key: &SigningKey) -> Result<(), AuthorizationServerError> {
        self.store.signing_keys.borrow_mut().push(key.clone());
        Ok(())
    }

    fn authorization_request_by_id(
        &mut self,
        id: &str,
    ) -> Result<Option<AuthorizationRequest>, AuthorizationServerError> {
        Ok(self.store.authorization_requests.borrow().get(id).cloned())
    }

    fn authorization_request_by_user_code(
        &mut self,
        user_code: &str,
    ) -> Result<Option<AuthorizationRequest>, AuthorizationServerError> {
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
    ) -> Result<Option<AuthorizationRequest>, AuthorizationServerError> {
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

    fn newest_pending_consent(
        &mut self,
    ) -> Result<Option<NewestPendingConsent>, AuthorizationServerError> {
        let requests = self.store.authorization_requests.borrow();
        let mut pending: Vec<&AuthorizationRequest> = requests
            .values()
            .filter(|r| r.status == RequestStatus::Pending && r.expires_at > Utc::now())
            .filter(|r| r.session_shortfall_acknowledged)
            .filter(|r| match r.grant_type {
                GrantType::AuthorizationCode => true,
                // Mirrors the SQL guard: a device row without its `user_code`
                // has no key the consent surface could fetch by, so it is not a
                // candidate rather than a request with a missing key.
                GrantType::DeviceCode => r.user_code.is_some(),
                GrantType::BrowserPairing => r.user_code.is_some() && r.device_name.is_some(),
            })
            .collect();
        pending.sort_by_key(|r| std::cmp::Reverse(r.requested_at));
        Ok(pending.first().and_then(|r| {
            // Mirrors the SQL left join: a client with no registration is
            // named by its `client_id`.
            let client_name = self
                .store
                .clients
                .borrow()
                .get(&r.client_id)
                .map_or_else(|| r.client_id.clone(), |client| client.name.clone());
            match r.grant_type {
                GrantType::AuthorizationCode => Some(NewestPendingConsent::OAuth {
                    id: r.id.clone(),
                    client_name,
                    decidable_in_requesting_browser: r.decidable_in_requesting_browser,
                }),
                GrantType::DeviceCode => {
                    r.user_code
                        .clone()
                        .map(|user_code| NewestPendingConsent::Device {
                            user_code,
                            client_name,
                        })
                }
                GrantType::BrowserPairing => r.user_code.clone().zip(r.device_name.clone()).map(
                    |(user_code, browser_name)| NewestPendingConsent::BrowserPairing {
                        user_code,
                        browser_name,
                    },
                ),
            }
        }))
    }

    fn insert_authorization_request(
        &mut self,
        request: &AuthorizationRequest,
    ) -> Result<(), AuthorizationServerError> {
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
    ) -> Result<bool, AuthorizationServerError> {
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

    fn deny_authorization_request(&mut self, id: &str) -> Result<bool, AuthorizationServerError> {
        let mut requests = self.store.authorization_requests.borrow_mut();
        let Some(request) = requests.get_mut(id) else {
            return Ok(false);
        };
        if request.status != RequestStatus::Pending {
            return Ok(false);
        }
        request.status = RequestStatus::Denied;
        Ok(true)
    }

    fn raise_authorization_request_for_owner(
        &mut self,
        id: &str,
    ) -> Result<bool, AuthorizationServerError> {
        let mut requests = self.store.authorization_requests.borrow_mut();
        let Some(request) = requests.get_mut(id) else {
            return Ok(false);
        };
        if request.status != RequestStatus::Pending {
            return Ok(false);
        }
        request.decidable_in_requesting_browser = false;
        Ok(true)
    }

    fn acknowledge_session_shortfall(
        &mut self,
        id: &str,
        expires_at: DateTime<Utc>,
    ) -> Result<bool, AuthorizationServerError> {
        let mut requests = self.store.authorization_requests.borrow_mut();
        let Some(request) = requests.get_mut(id) else {
            return Ok(false);
        };
        if request.status != RequestStatus::Pending || request.session_shortfall_acknowledged {
            return Ok(false);
        }
        request.session_shortfall_acknowledged = true;
        request.expires_at = expires_at;
        Ok(true)
    }

    fn consume_approved_authorization_request(
        &mut self,
        id: &str,
    ) -> Result<bool, AuthorizationServerError> {
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
    ) -> Result<(), AuthorizationServerError> {
        if let Some(request) = self.store.authorization_requests.borrow_mut().get_mut(id) {
            request.last_polled_at = Some(polled_at);
        }
        Ok(())
    }

    fn record_browser_pairing_poll(
        &mut self,
        id: &str,
        polled_at: DateTime<Utc>,
        browser_name: &str,
    ) -> Result<(), AuthorizationServerError> {
        if let Some(request) = self
            .store
            .authorization_requests
            .borrow_mut()
            .get_mut(id)
            .filter(|request| {
                request.grant_type == GrantType::BrowserPairing
                    && request.status == RequestStatus::Pending
            })
        {
            request.last_polled_at = Some(polled_at);
            request.device_name = Some(browser_name.to_owned());
        }
        Ok(())
    }

    fn redeem_authorization_code(
        &mut self,
        code: &str,
    ) -> Result<Option<IssuedAuthorizationCode>, AuthorizationServerError> {
        Ok(self.store.authorization_codes.borrow_mut().remove(code))
    }

    fn authorization_code_by_request_id(
        &mut self,
        request_id: &str,
    ) -> Result<Option<IssuedAuthorizationCode>, AuthorizationServerError> {
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
    ) -> Result<(), AuthorizationServerError> {
        self.store
            .authorization_codes
            .borrow_mut()
            .insert(code.code.clone(), code.clone());
        Ok(())
    }

    fn delete_authorization_requests_expired_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, AuthorizationServerError> {
        let mut requests = self.store.authorization_requests.borrow_mut();
        let before = requests.len();
        requests.retain(|_, r| r.expires_at >= cutoff);
        Ok(before - requests.len())
    }

    fn insert_launch_context(
        &mut self,
        context: &LaunchContext,
    ) -> Result<(), AuthorizationServerError> {
        self.store
            .launch_contexts
            .borrow_mut()
            .insert(context.nonce.clone(), context.clone());
        Ok(())
    }

    fn consume_launch_context(
        &mut self,
        nonce: &str,
        client_id: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<LaunchContext>, AuthorizationServerError> {
        let mut contexts = self.store.launch_contexts.borrow_mut();
        let Some(context) = contexts.get_mut(nonce).filter(|context| {
            context.admits_client(client_id)
                && context.consumed_at.is_none()
                && context.expires_at > now
        }) else {
            return Ok(None);
        };
        context.consumed_at = Some(now);
        Ok(Some(context.clone()))
    }

    fn launch_context_by_nonce(
        &mut self,
        nonce: &str,
    ) -> Result<Option<LaunchContext>, AuthorizationServerError> {
        Ok(self.store.launch_contexts.borrow().get(nonce).cloned())
    }

    fn delete_launch_contexts_expired_by(
        &mut self,
        now: DateTime<Utc>,
    ) -> Result<usize, AuthorizationServerError> {
        let mut contexts = self.store.launch_contexts.borrow_mut();
        let before = contexts.len();
        contexts.retain(|_, context| context.expires_at > now);
        Ok(before - contexts.len())
    }

    fn delete_authorization_codes_expired_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, AuthorizationServerError> {
        let mut codes = self.store.authorization_codes.borrow_mut();
        let before = codes.len();
        codes.retain(|_, c| c.expires_at >= cutoff);
        Ok(before - codes.len())
    }

    fn delete_refresh_token_families_expired_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, AuthorizationServerError> {
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

    fn insert_browser_session(
        &mut self,
        session: &BrowserSession,
    ) -> Result<(), AuthorizationServerError> {
        self.store
            .browser_sessions
            .borrow_mut()
            .insert(session.sid.clone(), session.clone());
        Ok(())
    }

    fn browser_session_by_sid(
        &mut self,
        sid: &str,
    ) -> Result<Option<BrowserSession>, AuthorizationServerError> {
        Ok(self.store.browser_sessions.borrow().get(sid).cloned())
    }

    fn live_browser_sessions(
        &mut self,
        now: DateTime<Utc>,
    ) -> Result<Vec<BrowserSession>, AuthorizationServerError> {
        let mut live: Vec<BrowserSession> = self
            .store
            .browser_sessions
            .borrow()
            .values()
            .filter(|session| session.revoked_at.is_none() && session.expires_at > now)
            .cloned()
            .collect();
        live.sort_by_key(|session| std::cmp::Reverse(session.created_at));
        Ok(live)
    }

    fn browser_session_is_revoked(&mut self, sid: &str) -> Result<bool, AuthorizationServerError> {
        Ok(self
            .store
            .browser_sessions
            .borrow()
            .get(sid)
            .is_none_or(|session| session.revoked_at.is_some()))
    }

    fn revoke_browser_session(
        &mut self,
        sid: &str,
        now: DateTime<Utc>,
    ) -> Result<bool, AuthorizationServerError> {
        Ok(
            match self.store.browser_sessions.borrow_mut().get_mut(sid) {
                Some(session) if session.revoked_at.is_none() => {
                    session.revoked_at = Some(now);
                    true
                }
                _ => false,
            },
        )
    }

    fn touch_browser_session_last_seen(
        &mut self,
        sid: &str,
        seen_at: DateTime<Utc>,
        seen_before: DateTime<Utc>,
    ) -> Result<bool, AuthorizationServerError> {
        Ok(
            match self.store.browser_sessions.borrow_mut().get_mut(sid) {
                Some(session) if session.last_seen_at <= seen_before => {
                    session.last_seen_at = seen_at;
                    true
                }
                _ => false,
            },
        )
    }

    fn delete_browser_sessions_ended_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, AuthorizationServerError> {
        let named_by_a_family_alive_at_cutoff: Vec<String> = self
            .store
            .families
            .borrow()
            .values()
            .filter(|family| family.expires_at >= cutoff)
            .filter_map(|family| family.sid.clone())
            .collect();
        let mut sessions = self.store.browser_sessions.borrow_mut();
        let before = sessions.len();
        sessions.retain(|sid, session| {
            let ended_before_cutoff = session.expires_at < cutoff
                || session
                    .revoked_at
                    .is_some_and(|revoked_at| revoked_at < cutoff);
            !ended_before_cutoff || named_by_a_family_alive_at_cutoff.contains(sid)
        });
        self.store
            .session_shortfall_acknowledgements
            .borrow_mut()
            .retain(|(sid, _)| sessions.contains_key(sid));
        Ok(before - sessions.len())
    }

    fn session_shortfall_acknowledged_for_client(
        &mut self,
        sid: &str,
        client_id: &str,
    ) -> Result<bool, AuthorizationServerError> {
        Ok(self
            .store
            .session_shortfall_acknowledgements
            .borrow()
            .contains(&(sid.to_owned(), client_id.to_owned())))
    }

    fn record_session_shortfall_acknowledgement(
        &mut self,
        sid: &str,
        client_id: &str,
    ) -> Result<(), AuthorizationServerError> {
        self.store
            .session_shortfall_acknowledgements
            .borrow_mut()
            .insert((sid.to_owned(), client_id.to_owned()));
        Ok(())
    }

    fn insert_refresh_token_family_row(
        &mut self,
        family: &RefreshTokenFamily,
    ) -> Result<(), AuthorizationServerError> {
        self.store
            .families
            .borrow_mut()
            .insert(family.family_id.clone(), family.clone());
        Ok(())
    }

    fn insert_refresh_token(
        &mut self,
        token: &RefreshToken,
    ) -> Result<(), AuthorizationServerError> {
        self.store
            .tokens
            .borrow_mut()
            .insert(token.token_hash.clone(), token.clone());
        Ok(())
    }

    fn refresh_token_with_family_by_hash(
        &mut self,
        token_hash: &str,
    ) -> Result<Option<(RefreshToken, RefreshTokenFamily)>, AuthorizationServerError> {
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
    ) -> Result<bool, AuthorizationServerError> {
        let mut tokens = self.store.tokens.borrow_mut();
        match tokens.get_mut(token_hash) {
            Some(token) if token.consumed_at.is_none() => {
                token.consumed_at = Some(now);
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    fn refresh_token_exists(&mut self, token_hash: &str) -> Result<bool, AuthorizationServerError> {
        Ok(self.store.tokens.borrow().contains_key(token_hash))
    }

    fn expire_refresh_token_family(
        &mut self,
        family_id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), AuthorizationServerError> {
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
    ) -> Result<(), AuthorizationServerError> {
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
    ) -> Result<(), AuthorizationServerError> {
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

    fn all_grants(&mut self) -> Result<Vec<Grant>, AuthorizationServerError> {
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

    fn grant_by_id(&mut self, id: &str) -> Result<Option<Grant>, AuthorizationServerError> {
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
    ) -> Result<Option<AuthorizationCodeGrant>, AuthorizationServerError> {
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
    ) -> Result<Option<DeviceGrant>, AuthorizationServerError> {
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
    ) -> Result<(), AuthorizationServerError> {
        self.store
            .code_grants
            .borrow_mut()
            .insert(grant.id.clone(), grant.clone());
        Ok(())
    }

    fn create_device_grant(&mut self, grant: &DeviceGrant) -> Result<(), AuthorizationServerError> {
        self.store
            .device_grants
            .borrow_mut()
            .insert(grant.id.clone(), grant.clone());
        Ok(())
    }

    fn update_authorization_code_grant(
        &mut self,
        grant: &AuthorizationCodeGrant,
    ) -> Result<(), AuthorizationServerError> {
        self.store
            .code_grants
            .borrow_mut()
            .insert(grant.id.clone(), grant.clone());
        Ok(())
    }

    fn update_device_grant(&mut self, grant: &DeviceGrant) -> Result<(), AuthorizationServerError> {
        self.store
            .device_grants
            .borrow_mut()
            .insert(grant.id.clone(), grant.clone());
        Ok(())
    }

    fn delete_authorization_code_grant(
        &mut self,
        id: &str,
    ) -> Result<bool, AuthorizationServerError> {
        Ok(self.store.code_grants.borrow_mut().remove(id).is_some())
    }

    fn delete_device_grant(&mut self, id: &str) -> Result<bool, AuthorizationServerError> {
        Ok(self.store.device_grants.borrow_mut().remove(id).is_some())
    }
}
