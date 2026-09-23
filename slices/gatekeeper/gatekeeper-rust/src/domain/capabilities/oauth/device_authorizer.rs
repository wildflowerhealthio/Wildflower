//! [`DeviceAuthorizer`] — the `/oauth/device_authorization` flow (RFC 8628
//! §3.1–3.2): for an [`AuthenticatedClient`], mint a `(device_code,
//! user_code)` pair, park the request, and raise the Owner's popup. Grants no
//! authority itself — the scopes it records are only what the device *asked*
//! for; the Owner's approval clamps them.

use std::sync::Arc;

use chrono::Duration;

use crate::crypto_util::oauth_user_code::generate_oauth_user_code;
use crate::crypto_util::random_token::generate_authorization_code;
use crate::domain::authority::AuthenticatedClient;
use crate::domain::authorization_request::{
    AuthorizationRequest, StartDeviceAuthorizationArgs, DEVICE_CODE_POLL_INTERVAL,
};
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::GatekeeperStore;
use crate::ports::PendingConsentPublisher;

/// Lifetime of a device-flow authorization request — the user has this long
/// to enter their `user_code` before the flow expires.
pub(crate) const DEVICE_AUTHORIZATION_TTL: Duration = Duration::minutes(5);

/// How many random `user_code` candidates are tried before giving up. Generous
/// because the alphabet/length make collisions astronomically rare.
const MAX_USER_CODE_GENERATION_ATTEMPTS: usize = 10;

/// The codes a started device authorization hands the device — the RFC 8628
/// §3.2 response minus the verification URIs, which the HTTP layer builds from
/// the served origin.
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
    Store(GatekeeperError),
}

impl From<GatekeeperError> for DeviceAuthorizationError {
    fn from(error: GatekeeperError) -> Self {
        DeviceAuthorizationError::Store(error)
    }
}

/// Start device authorizations. Generic over the store port so it's
/// unit-testable against the fake; the binding instantiates it over the
/// concrete `SqliteGatekeeperStore`.
pub(crate) struct DeviceAuthorizer<S: GatekeeperStore> {
    store: S,
    publisher: Arc<dyn PendingConsentPublisher>,
}

impl<S: GatekeeperStore> DeviceAuthorizer<S> {
    /// Build the authorizer over the store and the popup republish port, both
    /// lifted from the state.
    pub(crate) fn new(store: S, publisher: Arc<dyn PendingConsentPublisher>) -> Self {
        DeviceAuthorizer { store, publisher }
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
        client: &AuthenticatedClient,
        requested_scopes: Vec<String>,
        device_name: Option<String>,
    ) -> Result<DeviceCodes, DeviceAuthorizationError> {
        if !client.allows_scopes(&requested_scopes) {
            return Err(DeviceAuthorizationError::ScopeNotAllowed);
        }
        // 256-bit CSPRNG opaque token per RFC 6749 §10.10, like an
        // authorization code.
        let device_code = generate_authorization_code();
        let user_code = self.generate_unique_user_code()?;
        let request =
            AuthorizationRequest::new_device_authorization(StartDeviceAuthorizationArgs {
                id: device_code.clone(),
                client_id: client.client_id().to_owned(),
                requested_scopes,
                user_code: user_code.clone(),
                device_name,
                ttl: DEVICE_AUTHORIZATION_TTL,
            });
        self.store.insert_authorization_request(&request)?;
        // A fresh pending row may have just become the head of the consent
        // queue; republish so the host webview popup picks it up.
        self.publisher.republish_active();
        Ok(DeviceCodes {
            device_code,
            user_code,
            expires_in: DEVICE_AUTHORIZATION_TTL.num_seconds(),
            interval: DEVICE_CODE_POLL_INTERVAL.num_seconds(),
        })
    }

    /// A random `user_code` that collides with *no* existing request — pending
    /// or terminal: reusing a code attached to a denied/expired row would let
    /// that stale row shadow the new request at the consent-side lookup.
    fn generate_unique_user_code(&self) -> Result<String, DeviceAuthorizationError> {
        for _ in 0..MAX_USER_CODE_GENERATION_ATTEMPTS {
            let candidate = {
                let mut rng = rand::rng();
                generate_oauth_user_code(&mut rng)
            };
            if self
                .store
                .authorization_request_by_user_code(&candidate)?
                .is_none()
            {
                return Ok(candidate);
            }
        }
        Err(DeviceAuthorizationError::UserCodeExhausted)
    }
}

#[cfg(test)]
mod tests {

    use super::*;
    use crate::domain::authorization_request::{GrantType, RequestStatus};

    use crate::domain::test_fake::{
        authenticated_public_client, client, owned_scopes, FakeGatekeeperStore, RecordingPublisher,
    };

    fn authenticated(store: &FakeGatekeeperStore) -> AuthenticatedClient {
        authenticated_public_client(store, client("app", &["patient/*.rs", "openid"]))
    }

    /// A request inside the allowlist (by coverage, not spelling) is parked_request as
    /// a pending device request under its user code and the popup is raised.
    #[test]
    fn start_parks_a_pending_request_and_raises_the_popup() {
        let store = FakeGatekeeperStore::default();
        let client = authenticated(&store);
        let publisher = Arc::new(RecordingPublisher::default());
        let authorizer = DeviceAuthorizer::new(store, publisher.clone());
        let device_codes = authorizer
            .start(
                &client,
                owned_scopes(&["patient/Patient.r", "openid"]),
                Some("Kitchen iPad".to_owned()),
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
            .authorization_request_by_user_code(&device_codes.user_code)
            .unwrap()
            .expect("parked_request under the user code");
        assert_eq!(parked_request.id, device_codes.device_code);
        assert_eq!(parked_request.grant_type, GrantType::DeviceCode);
        assert_eq!(parked_request.status, RequestStatus::Pending);
        assert_eq!(
            parked_request.requested_scopes,
            ["patient/Patient.r", "openid"]
        );
        assert_eq!(parked_request.device_name.as_deref(), Some("Kitchen iPad"));
        assert_eq!(publisher.count(), 1);
    }

    /// A scope outside the allowlist refuses the whole request before anything
    /// is parked_request.
    #[test]
    fn start_refuses_a_scope_outside_the_allowlist() {
        let store = FakeGatekeeperStore::default();
        let client = authenticated(&store);
        let publisher = Arc::new(RecordingPublisher::default());
        let authorizer = DeviceAuthorizer::new(store, publisher.clone());
        assert!(matches!(
            authorizer.start(&client, owned_scopes(&["system/*.cruds"]), None),
            Err(DeviceAuthorizationError::ScopeNotAllowed)
        ));
        assert_eq!(publisher.count(), 0);
    }
}
