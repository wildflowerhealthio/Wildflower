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
use crate::domain::authorization_code::{AuthorizationCode, AUTHORIZATION_CODE_TTL};
use crate::domain::authorization_request::approval::Approval;
use crate::domain::authorization_request::code::{CodeRequest, NewCodeRequestArgs};
use crate::domain::authorization_request::device::{DeviceRequest, NewDeviceRequestArgs};
use crate::domain::authorization_request::pairing::{
    NewPairingRequestArgs, PairingApproval, PairingRequest,
};
use crate::domain::authorization_request::polled::Polled as _;
use crate::domain::authorization_request::session_widening::SessionWideningApproval;
use crate::domain::authorization_request::{AuthorizationRequest, RequestStatus};
use crate::domain::browser_session::BrowserSession;
use crate::domain::client::{AllowedGrantType, Client, ClientKind, RegistrationSource};
use crate::domain::client_credentials::ClientCredentials;
use crate::domain::grant::AuthorizationCodeGrant;
use crate::domain::grant_store::*;
use crate::domain::signing_key::SigningKey;
use crate::ports::{OwnerApproval, RevocationCheck};

/// A device-code request fixture from client `client` asking for `openid`,
/// started now and pending for five minutes, then moved to `status` (see
/// [`device_with_status`]).
pub(crate) fn device_request(id: &str, user_code: &str, status: RequestStatus) -> DeviceRequest {
    device_with_status(
        DeviceRequest::new(
            NewDeviceRequestArgs {
                id: id.to_owned(),
                client_id: "client".to_owned(),
                requested_scopes: owned_scopes(&["openid"]),
                ttl: Duration::minutes(5),
                user_code: user_code.to_owned(),
                device_name: None,
            },
            Utc::now(),
        ),
        status,
    )
}

/// A pending browser pairing fixture `id` from the browser-session client,
/// asking for the Owner's scopes, keyed by `user_code`, named `browser_name`,
/// live for five minutes.
pub(crate) fn pairing_request(id: &str, user_code: &str, browser_name: &str) -> PairingRequest {
    PairingRequest::new(
        NewPairingRequestArgs {
            id: id.to_owned(),
            client_id: crate::BROWSER_SESSION_CLIENT_ID.to_owned(),
            requested_scopes: crate::owner_scopes(),
            ttl: Duration::minutes(5),
            user_code: user_code.to_owned(),
            browser_name: browser_name.to_owned(),
        },
        Utc::now(),
    )
}

/// A pending code request fixture `id` from `client_id`, asking for
/// `requested_scopes`, carrying [`fixture_code_args`], live for five minutes.
pub(crate) fn code_request_for(
    id: &str,
    client_id: &str,
    requested_scopes: Vec<String>,
) -> CodeRequest {
    CodeRequest::new(
        fixture_code_args(id, client_id, requested_scopes),
        Utc::now(),
    )
}

/// `request`, a pending device request, moved to `status` by its own
/// transitions, taken just before it expires: an approval grants what it
/// asked for.
pub(crate) fn device_with_status(request: DeviceRequest, status: RequestStatus) -> DeviceRequest {
    let decided_at = request.expires_at - Duration::milliseconds(1);
    let approve = |request: &DeviceRequest| {
        request
            .approve(
                fixture_approval(&request.requested_scopes),
                None,
                decided_at,
            )
            .expect("a pending fixture approves")
    };
    match status {
        RequestStatus::Pending => request,
        RequestStatus::Approved => approve(&request),
        RequestStatus::Denied => request.deny(decided_at).expect("a pending fixture denies"),
        RequestStatus::Claimed => approve(&request)
            .claim(decided_at)
            .expect("an approved fixture is claimed"),
        RequestStatus::AwaitingLimitedPage => panic!("a device request has no limited page"),
    }
}

/// `request`, a pending code request, moved to `status` by its own
/// transitions, taken just before it expires: an approval grants what it
/// asked for.
pub(crate) fn code_with_status(request: CodeRequest, status: RequestStatus) -> CodeRequest {
    let decided_at = request.expires_at - Duration::milliseconds(1);
    match status {
        RequestStatus::Pending => request,
        RequestStatus::AwaitingLimitedPage => CodeRequest {
            state:
                crate::domain::authorization_request::code::CodeRequestState::AwaitingLimitedPage,
            ..request
        },
        RequestStatus::Approved => request
            .approve(fixture_approval(&request.requested_scopes), decided_at)
            .expect("a pending fixture approves"),
        RequestStatus::Denied => request.deny(decided_at).expect("a pending fixture denies"),
        RequestStatus::Claimed => panic!("a code request is never claimed"),
    }
}

/// An approval of `requested_scopes`, binding no patient.
fn fixture_approval(requested_scopes: &[String]) -> Approval {
    Approval {
        granted_scopes: requested_scopes.to_vec(),
        patient: None,
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
        .tx()
        .insert_browser_session(&BrowserSession {
            sid: FIXTURE_SID.to_owned(),
            ..BrowserSession::new_paired_session(
                "Firefox on Linux".to_owned(),
                vec!["wildflower/launch".to_owned()],
                Duration::hours(24),
                Utc::now(),
            )
        })
        .unwrap();
}

/// Approve the request `id` stored in `store` now, granting `granted_scopes`
/// and naming its device or browser `requester_name` (`None` keeps its own),
/// as an approval through the consent surfaces would.
pub(crate) fn approve_stored(
    store: &FakeGrantStore,
    id: &str,
    granted_scopes: &[&str],
    requester_name: Option<&str>,
) {
    let mut tx = store.tx();
    let request = tx
        .authorization_request_by_id(id)
        .unwrap()
        .expect("the request is stored");
    let approval = Approval {
        granted_scopes: owned_scopes(granted_scopes),
        patient: None,
    };
    let now = Utc::now();
    let requester_name = requester_name.map(str::to_owned);
    let landed = match request {
        AuthorizationRequest::Code(read) => {
            let approved = read.approve(approval, now).expect("pending");
            tx.replace_code_request(&read, &approved)
        }
        AuthorizationRequest::Device(read) => {
            let approved = read
                .approve(approval, requester_name, now)
                .expect("pending");
            tx.replace_device_request(&read, &approved)
        }
        AuthorizationRequest::Pairing(read) => {
            let approval = PairingApproval {
                granted_scopes: approval.granted_scopes,
            };
            let approved = read
                .approve(approval, requester_name, now)
                .expect("pending");
            tx.replace_pairing_request(&read, &approved)
        }
        AuthorizationRequest::SessionWidening(read) => {
            let approval = SessionWideningApproval {
                granted_scopes: approval.granted_scopes,
            };
            let approved = read.approve(approval, now).expect("pending");
            tx.replace_session_widening_request(&read, &approved)
        }
    };
    assert!(landed.unwrap());
}

/// How the code request fixtures start: `id` from `client_id`, asking for
/// `requested_scopes`, live for five minutes, with the `https://example.com/cb`
/// redirect, a PKCE challenge, the client `state`, and browser session
/// [`FIXTURE_SID`]; no launch, pending (not on its limited page), and not
/// decidable in the requesting browser.
pub(crate) fn fixture_code_args(
    id: &str,
    client_id: &str,
    requested_scopes: Vec<String>,
) -> NewCodeRequestArgs {
    NewCodeRequestArgs {
        id: id.to_owned(),
        client_id: client_id.to_owned(),
        requested_scopes,
        ttl: Duration::minutes(5),
        redirect_uri: Url::parse("https://example.com/cb").unwrap(),
        code_challenge: "c".repeat(43),
        client_state: "state".to_owned(),
        sid: FIXTURE_SID.to_owned(),
        launch: None,
        launch_bound_patient: None,
        pre_approved_scopes: Vec::new(),
        decidable_in_requesting_browser: false,
        awaits_limited_page: false,
    }
}

/// A code request fixture from client `client` asking for `read`, carrying
/// [`fixture_code_args`], expiring at `expires_at`, moved to `status` (see
/// [`code_with_status`]).
pub(crate) fn code_request(
    id: &str,
    status: RequestStatus,
    expires_at: DateTime<Utc>,
) -> CodeRequest {
    let now = Utc::now();
    code_with_status(
        CodeRequest::new(
            NewCodeRequestArgs {
                ttl: expires_at - now,
                ..fixture_code_args(id, "client", owned_scopes(&["read"]))
            },
            now,
        ),
        status,
    )
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
        registration_source: RegistrationSource::TrustedOnFirstUse,
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
    store.tx().insert_signing_key(&key).unwrap();
    key
}

/// Register `client` (which must be public) and authenticate as it.
pub(crate) fn authenticated_public_client(
    store: &FakeGrantStore,
    client: Client,
) -> AuthenticatedClient {
    let client_id = client.client_id.clone();
    store.tx().upsert_client(&client).unwrap();
    AuthenticatedClient::authenticate(
        &mut store.tx(),
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
        .tx()
        .issue_authorization_code(&AuthorizationCode {
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
        &mut store.tx(),
        &authenticated,
        &PresentedAuthorizationCode {
            code: &code,
            code_verifier: VERIFIER,
            redirect_uri: redirect_uri.as_str(),
        },
        now,
    )
    .expect("the fake store does not fail")
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
    /// How many times the Owner prompt has been republished.
    republishes: AtomicU32,
}

impl RecordingOwnerApproval {
    /// How many times the Owner prompt has been republished.
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
