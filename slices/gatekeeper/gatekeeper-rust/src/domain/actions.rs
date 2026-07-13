//! Domain actions over the [`GatekeeperStore`] port — the seam the HTTP routes
//! (and the boot/state machinery) call instead of touching a concrete store.
//! Each function takes `&impl GatekeeperStore`, so it runs against the `SQLite`
//! adapter in production and against the in-memory `FakeGatekeeperStore` in
//! tests, with no database or HTTP layer in the way.
//!
//! Two kinds of action live here, mirroring the split in `collector-rust` and
//! `tunnel-rust`:
//!
//!  - **Semantic** actions that apply the store's primitive absence/conflict
//!    signals (`Option` / `bool`) onto the domain's semantic
//!    [`GatekeeperError`] `*NotFound` variants — the consent loaders, the grant
//!    fetch/revoke, and the authorization-request fetch behind the polling
//!    endpoint. These carry the logic the semantic-mapping unit tests exercise.
//!  - **Thin relays** over the remaining store operations, so a handler never
//!    names a store method directly — the port stays reachable only through this
//!    layer (and the adapter that implements it). Pure crypto/HTTP logic (PKCE,
//!    token minting, JWK, cookies) stays in `crate::http`; only the
//!    store-touching step moves here.

use chrono::{DateTime, Utc};
use url::Url;

use crate::domain::authorization_code::AuthorizationCode;
use crate::domain::authorization_request::{AuthorizationRequest, GrantType, RequestStatus};
use crate::domain::client::Client;
use crate::domain::error::GatekeeperError;
use crate::domain::grant::{AuthorizationCodeGrant, DeviceGrant, Grant};
use crate::domain::refresh_token::{RefreshToken, RefreshTokenConsumeOutcome, RefreshTokenFamily};
use crate::domain::signing_key::SigningKey;
use crate::domain::GatekeeperStore;

// ===== clients ===========================================================

/// Look up a registered client by id — a thin relay; the callers decide how a
/// missing client renders (a local HTML page at `/authorize`, a 401 at
/// `/token`, a display-name fallback on the consent surfaces), so the mapping
/// stays HTTP-flow logic in the handlers.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn client_by_id(
    store: &impl GatekeeperStore,
    client_id: &str,
) -> Result<Option<Client>, GatekeeperError> {
    store.client_by_id(client_id)
}

// ===== signing keys ======================================================

/// Every signing key (active first) — the JWKS surface and the verify path.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn all_signing_keys(
    store: &impl GatekeeperStore,
) -> Result<Vec<SigningKey>, GatekeeperError> {
    store.all_signing_keys()
}

/// The active signing key, or `None` — the token-mint path.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn active_signing_key(
    store: &impl GatekeeperStore,
) -> Result<Option<SigningKey>, GatekeeperError> {
    store.active_signing_key()
}

/// Whether an active signing key exists — the `/authorize` up-front 503 probe.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn has_active_signing_key(
    store: &impl GatekeeperStore,
) -> Result<bool, GatekeeperError> {
    store.has_active_signing_key()
}

// ===== authorization requests ============================================

/// Load an authorization request by its primary id — a thin relay for callers
/// that apply their own status/flow logic (the device-code token exchange).
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn authorization_request_by_id(
    store: &impl GatekeeperStore,
    id: &str,
) -> Result<Option<AuthorizationRequest>, GatekeeperError> {
    store.authorization_request_by_id(id)
}

/// Load the authorization request behind the `/oauth/authorize/{id}` polling
/// endpoint, mapping an absent row to
/// [`GatekeeperError::AuthorizationRequestNotFound`] — the structured 404 the
/// polling page renders.
///
/// # Errors
///
/// [`GatekeeperError::AuthorizationRequestNotFound`] when no request has this id;
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn authorization_request_for_status(
    store: &impl GatekeeperStore,
    id: &str,
) -> Result<AuthorizationRequest, GatekeeperError> {
    store
        .authorization_request_by_id(id)?
        .ok_or_else(|| GatekeeperError::AuthorizationRequestNotFound { id: id.to_owned() })
}

/// Look up any authorization request bearing `user_code` — the device-flow
/// user-code uniqueness probe.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn authorization_request_by_user_code(
    store: &impl GatekeeperStore,
    user_code: &str,
) -> Result<Option<AuthorizationRequest>, GatekeeperError> {
    store.authorization_request_by_user_code(user_code)
}

/// The `user_code` of the FIFO head of the pending device-code consent queue —
/// the value the host popup advertises.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn oldest_pending_device_user_code(
    store: &impl GatekeeperStore,
) -> Result<Option<String>, GatekeeperError> {
    store.oldest_pending_device_user_code()
}

/// Persist a freshly-constructed authorization request (the store prunes expired
/// rows first).
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn insert_authorization_request(
    store: &impl GatekeeperStore,
    request: &AuthorizationRequest,
) -> Result<(), GatekeeperError> {
    store.insert_authorization_request(request)
}

/// Mark a pending request approved, returning `true` iff a pending row was
/// transitioned (the callers turn `false` into their own flow-specific
/// response).
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn approve_authorization_request(
    store: &impl GatekeeperStore,
    id: &str,
    granted_scopes: &[String],
    patient: Option<&str>,
    device_name: Option<&str>,
) -> Result<bool, GatekeeperError> {
    store.approve_authorization_request(id, granted_scopes, patient, device_name)
}

/// Mark a request denied.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn deny_authorization_request(
    store: &impl GatekeeperStore,
    id: &str,
) -> Result<(), GatekeeperError> {
    store.deny_authorization_request(id)
}

/// Atomically claim an approved device request for single-use redemption,
/// returning `true` iff this call won the race.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn consume_approved_authorization_request(
    store: &impl GatekeeperStore,
    id: &str,
) -> Result<bool, GatekeeperError> {
    store.consume_approved_authorization_request(id)
}

/// Stamp a device request's `last_polled_at`.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn record_device_poll(
    store: &impl GatekeeperStore,
    id: &str,
    polled_at: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    store.record_device_poll(id, polled_at)
}

/// A pending authorization-code consent request that has already passed the
/// loader's validation: it's `Pending`, an `AuthorizationCode` grant flow,
/// unexpired, and carries both a `redirect_uri` and a PKCE `code_challenge`.
/// Those two are unwrapped once here so handlers never re-prove them
/// (parse-don't-validate).
#[derive(Debug, PartialEq)]
pub struct PendingCodeConsent {
    pub request: AuthorizationRequest,
    pub redirect_uri: Url,
    pub code_challenge: String,
}

/// Load the authorization request for `id` and verify it's a pending,
/// unexpired authorization-code flow carrying both a `redirect_uri` and a
/// PKCE `code_challenge`. On success the two optional fields are unwrapped
/// into the returned [`PendingCodeConsent`] so callers never re-prove them
/// (parse-don't-validate). A request whose `expires_at` has passed
/// (`AUTHORIZATION_REQUEST_TTL`, 5 min) is treated as not found — nothing
/// actively transitions code-flow requests to `Expired`, so the deadline is
/// enforced here at read time.
///
/// # Errors
///
/// [`GatekeeperError::OAuthConsentNotFound`] when no pending, unexpired,
/// well-formed code-flow request has this id; [`GatekeeperError::Infrastructure`]
/// when the store read fails.
pub(crate) fn load_pending_authorization_code_request(
    store: &impl GatekeeperStore,
    id: &str,
) -> Result<PendingCodeConsent, GatekeeperError> {
    let consent_not_found = || GatekeeperError::OAuthConsentNotFound { id: id.to_owned() };
    match store.authorization_request_by_id(id)? {
        Some(r)
            if r.status == RequestStatus::Pending
                && r.grant_type == GrantType::AuthorizationCode
                && r.expires_at > Utc::now() =>
        {
            // For a code-flow request both fields are populated by
            // `new_code_authorization`; if either is somehow absent the row is
            // malformed and we refuse it rather than panic.
            match (r.redirect_uri.clone(), r.code_challenge.clone()) {
                (Some(redirect_uri), Some(code_challenge)) => Ok(PendingCodeConsent {
                    request: r,
                    redirect_uri,
                    code_challenge,
                }),
                _ => Err(consent_not_found()),
            }
        }
        _ => Err(consent_not_found()),
    }
}

/// Load the authorization request for `user_code` and verify it's a pending,
/// unexpired device-code flow.
///
/// # Errors
///
/// [`GatekeeperError::DeviceConsentNotFound`] when no pending, unexpired
/// device-flow request has this user code; [`GatekeeperError::Infrastructure`]
/// when the store read fails.
pub(crate) fn load_pending_device_request(
    store: &impl GatekeeperStore,
    user_code: &str,
) -> Result<AuthorizationRequest, GatekeeperError> {
    match store.pending_authorization_request_by_user_code(user_code)? {
        Some(r)
            if r.grant_type == GrantType::DeviceCode
                && r.status == RequestStatus::Pending
                && r.expires_at > Utc::now() =>
        {
            Ok(r)
        }
        _ => Err(GatekeeperError::DeviceConsentNotFound {
            user_code: user_code.to_owned(),
        }),
    }
}

// ===== authorization codes ===============================================

/// Atomically read-and-consume an authorization code (single-use).
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn redeem_authorization_code(
    store: &impl GatekeeperStore,
    code: &str,
) -> Result<Option<AuthorizationCode>, GatekeeperError> {
    store.redeem_authorization_code(code)
}

/// The code issued for a `request_id` — the polling endpoint's `Approved` arm.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn authorization_code_by_request_id(
    store: &impl GatekeeperStore,
    request_id: &str,
) -> Result<Option<AuthorizationCode>, GatekeeperError> {
    store.authorization_code_by_request_id(request_id)
}

/// Persist a freshly-minted authorization code.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn issue_authorization_code(
    store: &impl GatekeeperStore,
    code: &AuthorizationCode,
) -> Result<(), GatekeeperError> {
    store.issue_authorization_code(code)
}

// ===== refresh-token families ============================================

/// Persist a new refresh-token family plus its first token.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn insert_refresh_token_family(
    store: &impl GatekeeperStore,
    family: &RefreshTokenFamily,
    first_token: &RefreshToken,
) -> Result<(), GatekeeperError> {
    store.insert_refresh_token_family(family, first_token)
}

/// Resolve a presented token hash to its row plus owning family.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn refresh_token_with_family_by_hash(
    store: &impl GatekeeperStore,
    token_hash: &str,
) -> Result<Option<(RefreshToken, RefreshTokenFamily)>, GatekeeperError> {
    store.refresh_token_with_family_by_hash(token_hash)
}

/// Atomically rotate a refresh token (consume + insert successor).
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn rotate_refresh_token(
    store: &impl GatekeeperStore,
    presented_hash: &str,
    successor: &RefreshToken,
    now: DateTime<Utc>,
) -> Result<RefreshTokenConsumeOutcome, GatekeeperError> {
    store.rotate_refresh_token(presented_hash, successor, now)
}

/// End a single refresh-token family (reuse detection).
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn expire_refresh_token_family(
    store: &impl GatekeeperStore,
    family_id: &str,
    now: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    store.expire_refresh_token_family(family_id, now)
}

/// End every family minted from an authorization code (code-reuse detection).
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn expire_refresh_token_families_for_authorization_code(
    store: &impl GatekeeperStore,
    authorization_code_hash: &str,
    now: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    store.expire_refresh_token_families_for_authorization_code(authorization_code_hash, now)
}

// ===== grants ============================================================

/// Every standing grant — the Owner UI's access index.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn all_grants(store: &impl GatekeeperStore) -> Result<Vec<Grant>, GatekeeperError> {
    store.all_grants()
}

/// A single grant by id, or [`GatekeeperError::GrantNotFound`] when absent —
/// the `/access/grants/{id}` read (and the load-before-revoke).
///
/// # Errors
///
/// [`GatekeeperError::GrantNotFound`] when no grant has this id;
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn get_grant(store: &impl GatekeeperStore, id: &str) -> Result<Grant, GatekeeperError> {
    store
        .grant_by_id(id)?
        .ok_or_else(|| GatekeeperError::GrantNotFound { id: id.to_owned() })
}

/// The standing authorization-code grant for a (`client_id`, `redirect_uri`)
/// pair — the `/authorize` fast-path lookup.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn grant_by_client_and_redirect(
    store: &impl GatekeeperStore,
    client_id: &str,
    redirect_uri: &Url,
) -> Result<Option<AuthorizationCodeGrant>, GatekeeperError> {
    store.grant_by_client_and_redirect(client_id, redirect_uri)
}

/// The standing device grant for a (`client_id`, `device_name`) pair — the
/// token-exchange `grant_id` stamp.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn device_grant_by_client_and_device_name(
    store: &impl GatekeeperStore,
    client_id: &str,
    device_name: &str,
) -> Result<Option<DeviceGrant>, GatekeeperError> {
    store.device_grant_by_client_and_device_name(client_id, device_name)
}

/// Insert or cumulatively update the standing authorization-code grant.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn upsert_grant(
    store: &impl GatekeeperStore,
    client_id: &str,
    redirect_uri: &Url,
    scopes: &[String],
    patient: Option<&str>,
    now: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    store.upsert_grant(client_id, redirect_uri, scopes, patient, now)
}

/// Insert or cumulatively update the standing device grant.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn upsert_device_grant(
    store: &impl GatekeeperStore,
    client_id: &str,
    device_name: &str,
    scopes: &[String],
    patient: Option<&str>,
    now: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    store.upsert_device_grant(client_id, device_name, scopes, patient, now)
}

/// Revoke a grant (and expire the client's refresh-token families in the same
/// transaction), mapping the store's `false` "no such grant" outcome onto
/// [`GatekeeperError::GrantNotFound`] — so a revoke of an unknown/already-gone
/// grant renders the structured 404.
///
/// # Errors
///
/// [`GatekeeperError::GrantNotFound`] when no grant has this id;
/// [`GatekeeperError::Infrastructure`] if the store write fails.
pub(crate) fn revoke_grant(
    store: &impl GatekeeperStore,
    grant_id: &str,
    client_id: &str,
    now: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    if store.revoke_grant_and_expire_client_families(grant_id, client_id, now)? {
        Ok(())
    } else {
        Err(GatekeeperError::GrantNotFound {
            id: grant_id.to_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use chrono::Duration;

    use super::*;

    /// An in-memory [`GatekeeperStore`] modelling the primitive port semantics
    /// with no diesel and no database — enough to exercise the actions' semantic
    /// mapping (the `*NotFound` decisions and the consent-loader validation).
    /// The `SQLite` adapter's own SQL-level coverage lives in `crate::db`; this
    /// fake only needs to answer the primitive shapes the semantic actions build
    /// on, so the store operations the semantic tests never reach are simple
    /// in-memory stand-ins rather than faithful SQL replicas.
    #[derive(Default)]
    struct FakeGatekeeperStore {
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

        fn consume_approved_authorization_request(
            &self,
            id: &str,
        ) -> Result<bool, GatekeeperError> {
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

        fn issue_authorization_code(
            &self,
            code: &AuthorizationCode,
        ) -> Result<(), GatekeeperError> {
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

        fn create_grant(&self, grant: &Grant) -> Result<(), GatekeeperError> {
            match grant {
                Grant::AuthorizationCode(g) => {
                    self.code_grants
                        .borrow_mut()
                        .insert(g.id.clone(), g.clone());
                }
                Grant::DeviceCode(g) => {
                    self.device_grants
                        .borrow_mut()
                        .insert(g.id.clone(), g.clone());
                }
            }
            Ok(())
        }

        fn upsert_grant(
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

    fn device_request(id: &str, user_code: &str, status: RequestStatus) -> AuthorizationRequest {
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

    fn code_request(
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

    fn code_grant(id: &str, client_id: &str) -> Grant {
        Grant::AuthorizationCode(AuthorizationCodeGrant {
            id: id.to_owned(),
            client_id: client_id.to_owned(),
            scopes: vec!["read".to_owned()],
            granted_at: Utc::now(),
            last_used_at: None,
            patient: None,
            redirect_uri: Url::parse("https://example.com/cb").unwrap(),
        })
    }

    #[test]
    fn get_grant_returns_the_row_or_grant_not_found() {
        let store = FakeGatekeeperStore::default();
        store.create_grant(&code_grant("g1", "client")).unwrap();
        assert_eq!(get_grant(&store, "g1").unwrap().id(), "g1");
        assert_eq!(
            get_grant(&store, "ghost"),
            Err(GatekeeperError::GrantNotFound {
                id: "ghost".to_owned()
            }),
        );
    }

    #[test]
    fn revoke_grant_maps_the_miss_to_grant_not_found() {
        let store = FakeGatekeeperStore::default();
        store.create_grant(&code_grant("g1", "client")).unwrap();
        // First revoke removes the row and succeeds.
        assert_eq!(revoke_grant(&store, "g1", "client", Utc::now()), Ok(()));
        // Second revoke is a miss → GrantNotFound (the store returned `false`).
        assert_eq!(
            revoke_grant(&store, "g1", "client", Utc::now()),
            Err(GatekeeperError::GrantNotFound {
                id: "g1".to_owned()
            }),
        );
    }

    #[test]
    fn authorization_request_for_status_maps_absence_to_not_found() {
        let store = FakeGatekeeperStore::default();
        store
            .insert_authorization_request(&code_request(
                "req-1",
                RequestStatus::Pending,
                Utc::now() + Duration::minutes(5),
            ))
            .unwrap();
        assert_eq!(
            authorization_request_for_status(&store, "req-1")
                .unwrap()
                .id,
            "req-1"
        );
        assert_eq!(
            authorization_request_for_status(&store, "ghost"),
            Err(GatekeeperError::AuthorizationRequestNotFound {
                id: "ghost".to_owned()
            }),
        );
    }

    #[test]
    fn load_pending_code_request_accepts_a_live_request_and_unwraps_its_fields() {
        let store = FakeGatekeeperStore::default();
        store
            .insert_authorization_request(&code_request(
                "req-1",
                RequestStatus::Pending,
                Utc::now() + Duration::minutes(5),
            ))
            .unwrap();
        let loaded =
            load_pending_authorization_code_request(&store, "req-1").expect("live request");
        assert_eq!(loaded.request.id, "req-1");
        assert_eq!(loaded.redirect_uri.as_str(), "https://example.com/cb");
        assert_eq!(loaded.code_challenge.len(), 43);
    }

    #[test]
    fn load_pending_code_request_refuses_non_pending_expired_or_wrong_flow() {
        let store = FakeGatekeeperStore::default();
        // Denied → not found.
        store
            .insert_authorization_request(&code_request(
                "denied",
                RequestStatus::Denied,
                Utc::now() + Duration::minutes(5),
            ))
            .unwrap();
        // Pending but expired → not found (read-time deadline).
        store
            .insert_authorization_request(&code_request(
                "expired",
                RequestStatus::Pending,
                Utc::now() - Duration::minutes(1),
            ))
            .unwrap();
        // A pending device-code row → not found on the code-flow loader.
        store
            .insert_authorization_request(&device_request("device", "UC-1", RequestStatus::Pending))
            .unwrap();
        for id in ["denied", "expired", "device", "ghost"] {
            assert_eq!(
                load_pending_authorization_code_request(&store, id),
                Err(GatekeeperError::OAuthConsentNotFound { id: id.to_owned() }),
                "{id} must be OAuthConsentNotFound",
            );
        }
    }

    #[test]
    fn load_pending_device_request_accepts_live_and_refuses_the_rest() {
        let store = FakeGatekeeperStore::default();
        store
            .insert_authorization_request(&device_request(
                "dev-1",
                "LIVE-1",
                RequestStatus::Pending,
            ))
            .unwrap();
        store
            .insert_authorization_request(&device_request(
                "dev-2",
                "DENIED-1",
                RequestStatus::Denied,
            ))
            .unwrap();
        assert_eq!(
            load_pending_device_request(&store, "LIVE-1").unwrap().id,
            "dev-1"
        );
        for user_code in ["DENIED-1", "UNKNOWN"] {
            assert_eq!(
                load_pending_device_request(&store, user_code),
                Err(GatekeeperError::DeviceConsentNotFound {
                    user_code: user_code.to_owned()
                }),
            );
        }
    }
}
