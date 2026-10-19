//! Fixtures and small test doubles the domain unit tests share.

use std::sync::atomic::{AtomicU32, Ordering};

use chrono::{DateTime, Duration, Utc};
use url::Url;
use wildflowerhealthio_scopes::Grant;

use super::FakeGrantStore;
use crate::crypto_util::pkce::compute_code_challenge;
use crate::crypto_util::random_token::generate_authorization_code;
use crate::domain::authority::{
    ApprovableScopes, AuthenticatedClient, DelegatedScopes, PresentedAuthorizationCode,
    RedeemedAuthorizationCode,
};
use crate::domain::authorization_code::{IssuedAuthorizationCode, AUTHORIZATION_CODE_TTL};
use crate::domain::authorization_request::{AuthorizationRequest, GrantType, RequestStatus};
use crate::domain::browser_session::BrowserSession;
use crate::domain::client::{AllowedGrantType, Client, ClientKind};
use crate::domain::client_credentials::ClientCredentials;
use crate::domain::grant::AuthorizationCodeGrant;
use crate::domain::signing_key::SigningKey;
use crate::domain::GrantStore;
use crate::ports::{OwnerApproval, RevocationCheck};

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
        launch: None,
        launch_bound_patient: None,
        decidable_in_requesting_browser: false,
        sid: None,
        session_shortfall_acknowledged: true,
    }
}

/// The browser session the code-flow fixtures ([`code_request`],
/// [`redeemed_code`]) are made in. It names no session until
/// [`seed_fixture_browser_session`] starts it.
pub(crate) const FIXTURE_SID: &str = "sid-1";

/// Start [`FIXTURE_SID`]'s browser session in `store`, standing, so a fixture
/// request can be approved and the code and refresh family it earns are
/// honoured.
pub(crate) fn seed_fixture_browser_session(store: &FakeGrantStore) {
    store
        .insert_browser_session(&BrowserSession {
            sid: FIXTURE_SID.to_owned(),
            ..BrowserSession::new_approved(
                "Firefox on Linux".to_owned(),
                vec!["wildflower/launch".to_owned()],
                Duration::hours(24),
                Utc::now(),
            )
        })
        .unwrap();
}

/// A well-formed authorization-code request fixture (populated `redirect_uri`,
/// PKCE `code_challenge` and browser session [`FIXTURE_SID`]) with a
/// caller-chosen `status` and `expires_at`.
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
        launch: None,
        launch_bound_patient: None,
        decidable_in_requesting_browser: false,
        sid: Some(FIXTURE_SID.to_owned()),
        session_shortfall_acknowledged: true,
    }
}

/// A public-client fixture with a caller-chosen `allowed_scopes` set and the
/// `https://example.com/cb` redirect the request fixtures use.
pub(crate) fn client(client_id: &str, registered_client_scopes: &[&str]) -> Client {
    Client {
        client_id: client_id.to_owned(),
        name: format!("{client_id} display name"),
        kind: ClientKind::Public,
        redirect_uris: vec![Url::parse("https://example.com/cb").unwrap()],
        allowed_scopes: registered_client_scopes
            .iter()
            .map(|s| (*s).to_owned())
            .collect(),
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

/// Owned scope strings from literals.
pub(crate) fn owned_scopes(scopes: &[&str]) -> Vec<String> {
    scopes.iter().map(|s| (*s).to_owned()).collect()
}

/// Seed a freshly generated signing key as the active one, and return it.
pub(crate) fn seed_active_signing_key(store: &FakeGrantStore) -> SigningKey {
    let mut key = SigningKey::generate().expect("key");
    key.is_active = true;
    store.insert_signing_key(&key).unwrap();
    key
}

/// Register `client` (which must be public) and authenticate as it.
pub(crate) fn authenticated_public_client(
    store: &FakeGrantStore,
    client: Client,
) -> AuthenticatedClient {
    let client_id = client.client_id.clone();
    store.upsert_client(&client).unwrap();
    AuthenticatedClient::authenticate(
        store,
        &ClientCredentials {
            client_id,
            client_secret: None,
        },
    )
    .expect("a public client authenticates")
}

/// A code issued to `client_id` (registered here as a public client) for
/// `granted_scopes`, bound to patient `pat-1` and `https://example.com/cb`, then
/// redeemed through the real [`RedeemedAuthorizationCode::redeem`] — for a test
/// that needs the proof rather than the redemption rule. A standing grant the
/// test planted for that client and redirect is picked up.
pub(crate) fn redeemed_code(
    store: &FakeGrantStore,
    client_id: &str,
    granted_scopes: &[&str],
) -> RedeemedAuthorizationCode {
    const VERIFIER: &str = "verifier-verifier-verifier-verifier-verifier-1";
    let redirect_uri = Url::parse("https://example.com/cb").unwrap();
    let authenticated = authenticated_public_client(store, client(client_id, granted_scopes));
    let now = Utc::now();
    let code = generate_authorization_code();
    store
        .issue_authorization_code(&IssuedAuthorizationCode {
            code: code.clone(),
            request_id: "req".to_owned(),
            client_id: client_id.to_owned(),
            redirect_uri: redirect_uri.clone(),
            code_challenge: compute_code_challenge(VERIFIER),
            granted_scopes: owned_scopes(granted_scopes),
            patient: Some("pat-1".to_owned()),
            issued_at: now,
            expires_at: now + AUTHORIZATION_CODE_TTL,
            sid: FIXTURE_SID.to_owned(),
        })
        .unwrap();
    RedeemedAuthorizationCode::redeem(
        store,
        &authenticated,
        &PresentedAuthorizationCode {
            code: &code,
            code_verifier: VERIFIER,
            redirect_uri: redirect_uri.as_str(),
        },
        now,
    )
    .expect("a freshly issued code redeems")
}

/// `scopes` as delegated by an owner-equivalent approver, with nothing clamped
/// away.
pub(crate) fn delegated_scopes(scopes: &[&str]) -> DelegatedScopes {
    DelegatedScopes::clamp(
        &Grant::parse(["system/*.cruds", "wildflower/*.cruds"]),
        owned_scopes(scopes),
        &ApprovableScopes::for_device(&owned_scopes(scopes)),
    )
    .expect("the owner covers everything")
    .expect("non-empty")
}

/// `scopes` as delegated by an owner-equivalent approver to a code-flow client
/// trusted on first use, so recording them writes its registration.
pub(crate) fn registering_delegated_scopes(scopes: &[&str]) -> DelegatedScopes {
    DelegatedScopes::clamp(
        &Grant::parse(["system/*.cruds", "wildflower/*.cruds"]),
        owned_scopes(scopes),
        &ApprovableScopes::for_code(&owned_scopes(scopes), None, false),
    )
    .expect("the owner covers everything")
    .expect("non-empty")
}

/// A [`OwnerApproval`] that counts republish calls. Atomic (not a
/// `Cell`) so it satisfies the port's `Send + Sync` bound.
#[derive(Default)]
pub(crate) struct RecordingOwnerApproval {
    republishes: AtomicU32,
}

impl RecordingOwnerApproval {
    /// How many times the popup head has been republished.
    pub(crate) fn count(&self) -> u32 {
        self.republishes.load(Ordering::SeqCst)
    }
}

impl OwnerApproval for RecordingOwnerApproval {
    fn republish_active(&self) {
        self.republishes.fetch_add(1, Ordering::SeqCst);
    }
}

/// A [`RevocationCheck`] under which nothing is revoked: no denylisted `jti`
/// and no subject epoch.
pub(crate) struct NothingRevoked;

impl RevocationCheck for NothingRevoked {
    fn is_revoked(
        &self,
        _jti: Option<&str>,
        _issued_at: Option<DateTime<Utc>>,
        _subject: &str,
    ) -> Result<bool, String> {
        Ok(false)
    }
}
