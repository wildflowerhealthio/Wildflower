//! [`DeviceAuthorizer`] — the `/oauth/device_authorization` flow (RFC 8628
//! §3.1–3.2): for an [`AuthenticatedClient`], mint a `(device_code,
//! user_code)` pair, park the request, and raise the Owner's popup. Grants no
//! authority itself — the scopes it records are only what the device *asked*
//! for; the Owner's approval clamps them.

use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use url::Url;

use crate::crypto_util::oauth_user_code::generate_oauth_user_code;
use crate::crypto_util::random_token::generate_authorization_code;
use crate::domain::authority::AuthenticatedClient;
use crate::domain::authorization_request::{
    AuthorizationRequest, DeviceRequest, NewAuthorizationRequest, RequestKind,
    DEVICE_CODE_POLL_INTERVAL,
};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::grant_store::AuthorizationRequestsTx;
use crate::domain::GrantStore;
use crate::ports::OwnerApproval;

/// Lifetime of a device-flow authorization request — the user has this long
/// to enter their `user_code` before the flow expires.
pub(crate) const DEVICE_AUTHORIZATION_TTL: Duration = Duration::minutes(5);

/// How many random `user_code` candidates are tried before giving up. Generous
/// because the alphabet/length make collisions astronomically rare.
const MAX_USER_CODE_GENERATION_ATTEMPTS: usize = 10;

/// The codes a started device authorization hands the device — the RFC 8628
/// §3.2 response minus the verification URIs, which the HTTP layer builds from
/// the authorizer's [`device_page`](DeviceAuthorizer::device_page).
pub(crate) struct DeviceCodes {
    pub(crate) device_code: String,
    pub(crate) user_code: String,
    pub(crate) expires_in: i64,
    pub(crate) interval: i64,
}

/// The ways a device authorization can fail.
#[derive(Debug)]
pub(crate) enum DeviceAuthorizationError {
    /// A requested scope is outside the client's `allowed_scopes`
    /// (`invalid_scope`).
    ScopeNotAllowed,
    /// Every `user_code` candidate collided with an existing request.
    UserCodeExhausted,
    Store(AuthorizationServerError),
}

impl From<AuthorizationServerError> for DeviceAuthorizationError {
    fn from(error: AuthorizationServerError) -> Self {
        DeviceAuthorizationError::Store(error)
    }
}

/// Start device authorizations. Generic over the store port so it's
/// unit-testable against the fake; the binding instantiates it over the
/// concrete `SqliteGrantStore`.
pub(crate) struct DeviceAuthorizer<S: GrantStore> {
    store: S,
    owner_approval: Arc<dyn OwnerApproval>,
    device_page: Arc<Url>,
}

impl<S: GrantStore> DeviceAuthorizer<S> {
    /// Build the authorizer over the store, the popup republish port, and the
    /// server's device verification page, all lifted from the state.
    pub(crate) fn new(
        store: S,
        owner_approval: Arc<dyn OwnerApproval>,
        device_page: Arc<Url>,
    ) -> Self {
        DeviceAuthorizer {
            store,
            owner_approval,
            device_page,
        }
    }

    /// The server's device verification page, where the Owner enters a
    /// started authorization's `user_code`: the RFC 8628 `verification_uri`.
    pub(crate) fn device_page(&self) -> &Url {
        &self.device_page
    }

    /// Check the requested scopes against the client's allowlist (coverage-
    /// aware: a broad grant admits a narrower request it covers), mint the code
    /// pair, park the request under `device_name` (the name the approver sees
    /// and the grant is keyed on; `None` falls back to the client name at
    /// approval), and republish the popup head.
    ///
    /// # Errors
    ///
    /// [`DeviceAuthorizationError::ScopeNotAllowed`],
    /// [`DeviceAuthorizationError::UserCodeExhausted`], or a store failure.
    pub(crate) fn start(
        &self,
        authenticated_client: &AuthenticatedClient,
        requested_scopes: Vec<String>,
        device_name: Option<String>,
        now: DateTime<Utc>,
    ) -> Result<DeviceCodes, DeviceAuthorizationError> {
        if !authenticated_client.allows_scopes(&requested_scopes) {
            return Err(DeviceAuthorizationError::ScopeNotAllowed);
        }
        // 256-bit CSPRNG opaque token per RFC 6749 §10.10, like an
        // authorization code.
        let device_code = generate_authorization_code();
        let user_code = self
            .store
            .write(|tx| -> Result<_, DeviceAuthorizationError> {
                let user_code = generate_unique_user_code(tx)?
                    .ok_or(DeviceAuthorizationError::UserCodeExhausted)?;
                tx.insert_authorization_request(&AuthorizationRequest::new(
                    NewAuthorizationRequest {
                        id: device_code.clone(),
                        client_id: authenticated_client.client_id().to_owned(),
                        requested_scopes,
                        ttl: DEVICE_AUTHORIZATION_TTL,
                        kind: RequestKind::DeviceCode(DeviceRequest {
                            user_code: user_code.clone(),
                            device_name,
                            last_polled_at: None,
                        }),
                    },
                    now,
                ))?;
                Ok(user_code)
            })?;
        // A fresh pending row is now the newest pending consent; republish so
        // the host notifies it.
        self.owner_approval.republish_active();
        Ok(DeviceCodes {
            device_code,
            user_code,
            expires_in: DEVICE_AUTHORIZATION_TTL.num_seconds(),
            interval: DEVICE_CODE_POLL_INTERVAL.num_seconds(),
        })
    }
}

/// A random `user_code` that collides with *no* existing request in `tx` —
/// pending or terminal, of any flow: reusing a code attached to a
/// denied/expired row would let that stale row shadow the new request at the
/// consent-side lookup. `None` when every candidate collided.
///
/// # Errors
///
/// The store's, when reading a candidate's request fails.
pub(super) fn generate_unique_user_code(
    tx: &mut impl AuthorizationRequestsTx,
) -> Result<Option<String>, AuthorizationServerError> {
    for _ in 0..MAX_USER_CODE_GENERATION_ATTEMPTS {
        let candidate = {
            let mut rng = rand::rng();
            generate_oauth_user_code(&mut rng)
        };
        if tx.authorization_request_by_user_code(&candidate)?.is_none() {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use crate::domain::grant_store::*;

    use super::*;

    use crate::domain::test_fake::{
        authenticated_public_client, client, owned_scopes, FakeGrantStore, RecordingOwnerApproval,
    };

    /// A device verification page for the authorizer under test; `start`
    /// doesn't read it.
    fn device_page() -> Arc<Url> {
        Arc::new(Url::parse("https://dev1.example.com/oauth/device").expect("a URL"))
    }

    fn authenticated(store: &FakeGrantStore) -> AuthenticatedClient {
        authenticated_public_client(store, client("app", &["patient/*.rs", "openid"]))
    }

    /// A request inside the allowlist (by coverage, not spelling) is parked as
    /// a pending device request under its user code and the popup is raised.
    #[test]
    fn start_parks_a_pending_request_and_raises_the_popup() {
        let store = FakeGrantStore::default();
        let client = authenticated(&store);
        let owner_approval = Arc::new(RecordingOwnerApproval::default());
        let authorizer = DeviceAuthorizer::new(store, owner_approval.clone(), device_page());
        let now = Utc::now();
        let device_codes = authorizer
            .start(
                &client,
                owned_scopes(&["patient/Patient.r", "openid"]),
                Some("Kitchen iPad".to_owned()),
                now,
            )
            .expect("starts");
        assert_eq!(
            device_codes.expires_in,
            DEVICE_AUTHORIZATION_TTL.num_seconds()
        );
        assert_eq!(
            device_codes.interval,
            DEVICE_CODE_POLL_INTERVAL.num_seconds()
        );
        let parked_request = authorizer
            .store
            .tx()
            .authorization_request_by_user_code(&device_codes.user_code)
            .unwrap()
            .expect("parked_request under the user code");
        assert_eq!(
            parked_request,
            AuthorizationRequest::new(
                NewAuthorizationRequest {
                    id: device_codes.device_code,
                    client_id: "app".to_owned(),
                    requested_scopes: owned_scopes(&["patient/Patient.r", "openid"]),
                    ttl: DEVICE_AUTHORIZATION_TTL,
                    kind: RequestKind::DeviceCode(DeviceRequest {
                        user_code: device_codes.user_code,
                        device_name: Some("Kitchen iPad".to_owned()),
                        last_polled_at: None,
                    }),
                },
                now,
            )
        );
        assert_eq!(owner_approval.count(), 1);
    }

    /// A scope outside the allowlist refuses the whole request before anything
    /// is parked.
    #[test]
    fn start_refuses_a_scope_outside_the_allowlist() {
        let store = FakeGrantStore::default();
        let client = authenticated(&store);
        let owner_approval = Arc::new(RecordingOwnerApproval::default());
        let authorizer = DeviceAuthorizer::new(store, owner_approval.clone(), device_page());
        assert!(matches!(
            authorizer.start(&client, owned_scopes(&["system/*.cruds"]), None, Utc::now()),
            Err(DeviceAuthorizationError::ScopeNotAllowed)
        ));
        assert_eq!(owner_approval.count(), 0);
    }
}
