//! Consent capabilities — the `wildflower/AuthorizationRequest.*` capabilities
//! behind `/access/oauth-consents/*` and `/access/devices/*`, and the consent
//! operations they own. The transaction scripts (load-and-validate, the
//! approve/deny flows, the standing-grant upserts they trigger) live here as
//! `&impl GatekeeperStore` functions so they stay unit-testable against the
//! in-memory fake; the capabilities are the scope-gated entries, generic over the
//! store and holding the port dependencies lifted from the state.
//!
//! The code-flow surfaces additionally carry the **registration verdict** (see
//! [`crate::domain::client_registration`]): the prompt renders it, and an
//! approval that steps outside the registration must acknowledge it. Computing
//! it needs the self-hosted redirect seam and the request's served origin, which
//! is why both consent capabilities hold a
//! [`SelfHostedRedirectResolver`] and take a `served_origin`.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use scopes_rust::{Grant, Permission, Scope, WildflowerResource};

use crate::domain::authorization_code::PendingCodeConsent;
use crate::domain::authorization_request::AuthorizationRequest;
use crate::domain::client::Client;
use crate::domain::client_registration::{
    classify_registration, ClientRegistration, PendingRegistration,
};
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::GatekeeperStore;
use crate::ports::{DeviceUserCodePublisher, SelfHostedRedirectResolver};

mod delegation;
mod device;
mod oauth;

use device::{approve_device_consent, deny_device_consent, load_pending_device_request};
use oauth::{
    approve_oauth_consent, deny_oauth_consent, load_pending_authorization_code_request,
    ApprovalContext,
};

/// The scope gating [`ConsentReader`] — `wildflower/AuthorizationRequest.r`.
pub(crate) fn consent_reader_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::AuthorizationRequest,
        Permission::READ,
    )]
}

/// The scope gating [`ConsentDecider`] — `wildflower/AuthorizationRequest.u`.
pub(crate) fn consent_decider_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::AuthorizationRequest,
        Permission::UPDATE,
    )]
}

// ---------------------------------------------------------------------------
// Read models the Owner UI renders — the shapes the `GET` consent handlers
// return. Pure domain data (no axum), produced by `ConsentReader`.
// ---------------------------------------------------------------------------

/// A consent prompt loaded for the Owner UI to render — the data a `GET`
/// authorization-code consent handler needs, with the client's display name and
/// its [registration verdict](ClientRegistration) already resolved.
pub(crate) struct OAuthConsentView {
    pub(crate) request: AuthorizationRequest,
    pub(crate) redirect_uri: url::Url,
    pub(crate) client_name: String,
    /// How this request compares against the client's registration **as it
    /// stands now** — the warning the prompt leads with when the app, its
    /// redirect, or its scopes are new to the Owner. Recomputed on every read,
    /// never stored.
    pub(crate) registration: ClientRegistration,
}

/// The request-scoped inputs the [registration verdict](ClientRegistration)
/// needs beyond the store: the self-hosted redirect seam (to expand an
/// app-relative allowlist entry) and the origin this request was served on (the
/// base it expands against), plus the first-party `client_id` the trust-on-first
/// -use path exempts.
///
/// Assembled by the consent capabilities from the handles they hold plus the
/// handler's `ServedOrigin`, so the verdict a prompt renders is computed exactly
/// the way `/authorize` computed it.
pub(crate) struct RegistrationContext<'a> {
    /// Resolves a `client_id` to a self-hosted app's `{port, subdomain}`.
    pub(crate) redirects: &'a dyn SelfHostedRedirectResolver,
    /// The origin this request was served on, unparsed.
    pub(crate) served_origin: &'a str,
    /// The first-party host's `client_id`, which is never trusted on first use
    /// and whose registration an approval never widens.
    pub(crate) first_party_client_id: &'a str,
}

impl RegistrationContext<'_> {
    /// Classify a pending request against `client` (the current row, or `None`
    /// when the id is unknown), expanding app-relative allowlist entries for this
    /// request's provenance.
    pub(crate) fn classify(
        &self,
        client_id: &str,
        client: Option<&Client>,
        redirect_uri: &url::Url,
        requested_scopes: &[String],
    ) -> ClientRegistration {
        let topology = self.redirects.resolve(client_id);
        // An unparseable served origin simply resolves no app-relative entry;
        // absolute entries still match.
        let served = url::Url::parse(self.served_origin).ok();
        classify_registration(&PendingRegistration {
            client,
            redirect_uri,
            requested_scopes,
            served_origin: served.as_ref(),
            topology: topology.as_ref(),
        })
    }

    /// Whether `client_id` is the first-party host — the one client held to its
    /// registration rather than trusted on first use.
    pub(crate) fn is_first_party(&self, client_id: &str) -> bool {
        client_id == self.first_party_client_id
    }
}

/// A device-code consent prompt loaded for the Owner UI — adds the client's full
/// `allowed_scopes` (the expansion envelope the approver may grant up to).
pub(crate) struct DeviceConsentView {
    pub(crate) request: AuthorizationRequest,
    pub(crate) client_name: String,
    pub(crate) allowed_scopes: Vec<String>,
}

// ---------------------------------------------------------------------------
// Decision inputs / outcome.
// ---------------------------------------------------------------------------

/// The Owner's decision on a consent prompt, after the action has applied it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ConsentOutcome {
    /// Approved. `redirect` is the client callback URL to hand back so an
    /// approving surface that *is* the requesting client can finish inline
    /// (code flow with a `client_state`); `None` for the device flow.
    Approved { redirect: Option<String> },
    /// Nothing was granted — no requested-and-allowed scope was approved, so the
    /// request was denied.
    Denied,
}

/// The Owner's approval of an authorization-code consent prompt.
pub(crate) struct ApproveOAuthConsentInput {
    /// The scopes the Owner ticked.
    pub approved_scopes: Vec<String>,
    /// Optional SMART-on-FHIR patient context to bind to the grant.
    pub patient: Option<String>,
    /// The Owner's explicit acknowledgement that they recognise this app and
    /// its redirect address. Required when the
    /// [registration verdict](ClientRegistration) is
    /// [`New`](ClientRegistration::New) or
    /// [`Changed`](ClientRegistration::Changed) — approving without it fails
    /// with [`GatekeeperError::RegistrationNotAcknowledged`]. Ignored for a
    /// [`Registered`](ClientRegistration::Registered) request, which shows no
    /// warning to acknowledge.
    pub acknowledged_registration: bool,
}

/// The Owner's approval of a device-code consent prompt.
pub(crate) struct ApproveDeviceConsentInput {
    /// The scopes the Owner ticked.
    pub approved_scopes: Vec<String>,
    /// Optional SMART-on-FHIR patient context to bind to the grant.
    pub patient: Option<String>,
    /// An optional adjusted device name (the approver renaming the device before
    /// approving); falls back to the device's own name, then the client's name.
    pub device_name: Option<String>,
}

// ---------------------------------------------------------------------------
// The capabilities.
// ---------------------------------------------------------------------------

/// Read access to pending consent prompts — the `GET` sides of
/// `/access/oauth-consents/{id}` and `/access/devices/{userCode}`.
pub(crate) struct ConsentReader<S: GatekeeperStore> {
    store: S,
    redirects: Arc<dyn SelfHostedRedirectResolver>,
    first_party_client_id: Arc<str>,
}

impl<S: GatekeeperStore> ConsentReader<S> {
    /// Build the reader over a store handle, the self-hosted redirect seam, and
    /// the first-party `client_id` — all lifted from the state. The latter two
    /// feed the [registration verdict](ClientRegistration) each prompt carries.
    pub(crate) fn new(
        store: S,
        redirects: Arc<dyn SelfHostedRedirectResolver>,
        first_party_client_id: Arc<str>,
    ) -> Self {
        ConsentReader {
            store,
            redirects,
            first_party_client_id,
        }
    }

    /// The request-scoped registration inputs for a prompt served on `origin`.
    fn registration_context<'a>(&'a self, origin: &'a str) -> RegistrationContext<'a> {
        RegistrationContext {
            redirects: self.redirects.as_ref(),
            served_origin: origin,
            first_party_client_id: &self.first_party_client_id,
        }
    }

    /// Load a pending authorization-code consent prompt for the Owner UI, with
    /// the client's display name and its registration verdict resolved against
    /// the current row. `served_origin` is the origin the Owner UI's request
    /// arrived on — the base an app-relative redirect entry resolves against, so
    /// the verdict agrees with the one `/authorize` computed.
    pub(crate) fn oauth_consent(
        &self,
        id: &str,
        served_origin: &str,
    ) -> Result<OAuthConsentView, GatekeeperError> {
        let PendingCodeConsent {
            request,
            redirect_uri,
            ..
        } = load_pending_authorization_code_request(&self.store, id)?;
        // A missing row is the `New` verdict, and its name falls back to the raw
        // `client_id` — a store failure reads the same way, deliberately: the
        // prompt still renders, warning rather than silently reassuring.
        let client = self.store.client_by_id(&request.client_id).ok().flatten();
        let client_name = client
            .as_ref()
            .map_or_else(|| request.client_id.clone(), |c| c.name.clone());
        let registration = self.registration_context(served_origin).classify(
            &request.client_id,
            client.as_ref(),
            &redirect_uri,
            &request.requested_scopes,
        );
        Ok(OAuthConsentView {
            request,
            redirect_uri,
            client_name,
            registration,
        })
    }

    /// Load a pending device-code consent prompt for the Owner UI, with the
    /// client's name and expansion envelope resolved.
    pub(crate) fn device_consent(
        &self,
        user_code: &str,
    ) -> Result<DeviceConsentView, GatekeeperError> {
        let request = load_pending_device_request(&self.store, user_code)?;
        let (client_name, allowed_scopes) = match self.store.client_by_id(&request.client_id) {
            Ok(Some(client)) => (client.name, client.allowed_scopes),
            _ => (request.client_id.clone(), Vec::new()),
        };
        Ok(DeviceConsentView {
            request,
            client_name,
            allowed_scopes,
        })
    }
}

/// Decide (approve/deny) pending consent prompts — the `approve`/`deny` sides of
/// both consent surfaces. Statically gated by `AuthorizationRequest.u`, and it
/// additionally holds the caller's own [`Grant`] (the approve paths reject any
/// delegation beyond the approver's authority) plus the device-consent
/// [`DeviceUserCodePublisher`] port — both lifted from the state.
pub(crate) struct ConsentDecider<S: GatekeeperStore> {
    store: S,
    publisher: Arc<dyn DeviceUserCodePublisher>,
    approver: Grant,
    redirects: Arc<dyn SelfHostedRedirectResolver>,
    first_party_client_id: Arc<str>,
}

impl<S: GatekeeperStore> ConsentDecider<S> {
    /// Build the decider over a store handle, the republish port, the approver's
    /// own granted scopes, the self-hosted redirect seam, and the first-party
    /// `client_id` — all lifted from the state + claims. The last two feed the
    /// [registration verdict](ClientRegistration) a code-flow approval is checked
    /// against.
    pub(crate) fn new(
        store: S,
        publisher: Arc<dyn DeviceUserCodePublisher>,
        approver: Grant,
        redirects: Arc<dyn SelfHostedRedirectResolver>,
        first_party_client_id: Arc<str>,
    ) -> Self {
        ConsentDecider {
            store,
            publisher,
            approver,
            redirects,
            first_party_client_id,
        }
    }

    /// Approve an authorization-code consent; a resource scope beyond the
    /// approver's own authority fails the approval with a `403`, and an
    /// unacknowledged [`New`](ClientRegistration::New) /
    /// [`Changed`](ClientRegistration::Changed) registration fails it with a
    /// `409`. `served_origin` is the origin the approval arrived on, so the
    /// verdict matches the one the prompt rendered.
    pub(crate) fn approve_oauth(
        &self,
        id: &str,
        input: ApproveOAuthConsentInput,
        generate_code: impl FnOnce() -> String,
        now: DateTime<Utc>,
        served_origin: &str,
    ) -> Result<ConsentOutcome, GatekeeperError> {
        approve_oauth_consent(
            &self.store,
            self.publisher.as_ref(),
            id,
            input,
            generate_code,
            &ApprovalContext {
                approver: &self.approver,
                registration: &RegistrationContext {
                    redirects: self.redirects.as_ref(),
                    served_origin,
                    first_party_client_id: &self.first_party_client_id,
                },
                now,
            },
        )
    }

    /// Deny an authorization-code consent.
    pub(crate) fn deny_oauth(&self, id: &str) -> Result<(), GatekeeperError> {
        deny_oauth_consent(&self.store, self.publisher.as_ref(), id)
    }

    /// Approve a device-code consent; a resource scope beyond the approver's own
    /// authority fails the approval with a `403`.
    pub(crate) fn approve_device(
        &self,
        user_code: &str,
        input: ApproveDeviceConsentInput,
        now: DateTime<Utc>,
    ) -> Result<ConsentOutcome, GatekeeperError> {
        approve_device_consent(
            &self.store,
            self.publisher.as_ref(),
            user_code,
            input,
            &self.approver,
            now,
        )
    }

    /// Deny a device-code consent.
    pub(crate) fn deny_device(&self, user_code: &str) -> Result<(), GatekeeperError> {
        deny_device_consent(&self.store, self.publisher.as_ref(), user_code)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};

    use chrono::Duration;

    use super::oauth::{upsert_authorization_code_grant, RegistrationWrite};
    use super::*;
    use crate::domain::authorization_request::RequestStatus;
    use crate::domain::client::RegisteredRedirectUri;
    use crate::domain::test_fake::{client, code_request, device_request, FakeGatekeeperStore};
    use crate::ports::NoSelfHostedRedirects;

    /// The registration inputs the code-consent tests share: no self-hosted app
    /// (so app-relative entries resolve to nothing), the loopback served origin,
    /// and the real first-party id — which the `client` fixture never uses, so
    /// the fixture client always takes the trust-on-first-use path.
    const TEST_REGISTRATION: RegistrationContext<'static> = RegistrationContext {
        redirects: &NoSelfHostedRedirects,
        served_origin: "http://127.0.0.1",
        first_party_client_id: crate::FIRST_PARTY_CLIENT_ID,
    };

    /// Approve a code-flow consent with the shared registration context.
    fn approve_code(
        store: &FakeGatekeeperStore,
        publisher: &RecordingPublisher,
        id: &str,
        input: ApproveOAuthConsentInput,
        approver: &Grant,
        generate_code: impl FnOnce() -> String,
    ) -> Result<ConsentOutcome, GatekeeperError> {
        approve_oauth_consent(
            store,
            publisher,
            id,
            input,
            generate_code,
            &ApprovalContext {
                approver,
                registration: &TEST_REGISTRATION,
                now: Utc::now(),
            },
        )
    }

    /// An approval of everything requested, acknowledged — the common input.
    fn approved(scopes: &[&str]) -> ApproveOAuthConsentInput {
        ApproveOAuthConsentInput {
            approved_scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
            patient: None,
            acknowledged_registration: true,
        }
    }

    /// A [`DeviceUserCodePublisher`] that just counts republish calls. Uses an
    /// atomic (not a `Cell`) so it satisfies the port's `Send + Sync` bound.
    #[derive(Default)]
    struct RecordingPublisher {
        republishes: AtomicU32,
    }

    impl RecordingPublisher {
        fn count(&self) -> u32 {
            self.republishes.load(Ordering::Relaxed)
        }
    }

    impl DeviceUserCodePublisher for RecordingPublisher {
        fn republish_active(&self) {
            self.republishes.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// An owner-equivalent approver grant — the two universal resource wildcards.
    fn owner_grant() -> Grant {
        Grant::parse(["wildflower/*.cruds", "system/*.cruds"])
    }

    fn live_code_store() -> (FakeGatekeeperStore, RecordingPublisher) {
        let store = FakeGatekeeperStore::default();
        store.upsert_client(&client("client", &["read"])).unwrap();
        store
            .insert_authorization_request(&code_request(
                "req-1",
                RequestStatus::Pending,
                Utc::now() + Duration::minutes(5),
            ))
            .unwrap();
        (store, RecordingPublisher::default())
    }

    #[test]
    fn approve_oauth_consent_mints_a_code_and_returns_the_redirect() {
        let (store, publisher) = live_code_store();
        let outcome = approve_code(
            &store,
            &publisher,
            "req-1",
            approved(&["read"]),
            &owner_grant(),
            || "the-code".to_owned(),
        )
        .unwrap();
        assert_eq!(
            outcome,
            ConsentOutcome::Approved {
                redirect: Some("https://example.com/cb?code=the-code&state=state".to_owned()),
            },
        );
        assert!(store
            .authorization_code_by_request_id("req-1")
            .unwrap()
            .is_some());
        assert!(store
            .grant_by_client_and_redirect(
                "client",
                &url::Url::parse("https://example.com/cb").unwrap(),
            )
            .unwrap()
            .is_some());
        assert_eq!(publisher.count(), 0);
    }

    #[test]
    fn approve_oauth_consent_with_nothing_granted_is_a_deny() {
        let (store, publisher) = live_code_store();
        let outcome = approve_code(
            &store,
            &publisher,
            "req-1",
            approved(&["write"]),
            &owner_grant(),
            || panic!("must not mint a code on a deny"),
        )
        .unwrap();
        assert_eq!(outcome, ConsentOutcome::Denied);
        assert_eq!(
            store
                .authorization_request_by_id("req-1")
                .unwrap()
                .unwrap()
                .status,
            RequestStatus::Denied,
        );
        assert_eq!(publisher.count(), 1);
    }

    /// A client this gatekeeper has never seen reaches consent (nothing is
    /// registered at `/authorize`), and approving it **without** the Owner's
    /// acknowledgement writes nothing at all: no client row, no grant, no code,
    /// and the prompt stays pending so they can decide again.
    #[test]
    fn approve_oauth_consent_rejects_an_unacknowledged_new_client() {
        let store = FakeGatekeeperStore::default();
        let publisher = RecordingPublisher::default();
        store
            .insert_authorization_request(&code_request(
                "req-1",
                RequestStatus::Pending,
                Utc::now() + Duration::minutes(5),
            ))
            .unwrap();
        let result = approve_code(
            &store,
            &publisher,
            "req-1",
            ApproveOAuthConsentInput {
                approved_scopes: vec!["read".to_owned()],
                patient: None,
                acknowledged_registration: false,
            },
            &owner_grant(),
            || panic!("must not mint a code for an unacknowledged registration"),
        );
        assert_eq!(
            result,
            Err(GatekeeperError::RegistrationNotAcknowledged {
                id: "req-1".to_owned()
            }),
        );
        assert!(store.client_by_id("client").unwrap().is_none());
        assert!(store
            .grant_by_client_and_redirect(
                "client",
                &url::Url::parse("https://example.com/cb").unwrap(),
            )
            .unwrap()
            .is_none());
        assert_eq!(
            store
                .authorization_request_by_id("req-1")
                .unwrap()
                .unwrap()
                .status,
            RequestStatus::Pending,
        );
    }

    /// An acknowledged approval of a new client registers it: a public client
    /// named after its own `client_id`, holding the one redirect it used and
    /// exactly the granted scopes.
    #[test]
    fn approve_oauth_consent_registers_an_acknowledged_new_client() {
        let store = FakeGatekeeperStore::default();
        let publisher = RecordingPublisher::default();
        store
            .insert_authorization_request(&code_request(
                "req-1",
                RequestStatus::Pending,
                Utc::now() + Duration::minutes(5),
            ))
            .unwrap();
        approve_code(
            &store,
            &publisher,
            "req-1",
            approved(&["read"]),
            &owner_grant(),
            || "the-code".to_owned(),
        )
        .unwrap();
        let registered = store.client_by_id("client").unwrap().expect("client row");
        assert_eq!(registered.name, "client");
        assert_eq!(registered.kind, crate::domain::client::ClientKind::Public);
        assert_eq!(
            registered.redirect_uris,
            vec![RegisteredRedirectUri::Absolute(
                url::Url::parse("https://example.com/cb").unwrap()
            )],
        );
        assert_eq!(registered.allowed_scopes, vec!["read".to_owned()]);
        assert_eq!(
            registered.allowed_grant_types,
            crate::domain::client::AllowedGrantType::ALL.to_vec(),
        );
        assert!(registered.secret_hash.is_none());
        assert!(registered.disabled_at.is_none());
    }

    /// Approving a known client's changed request widens its row in place: the
    /// new redirect is appended to the existing allowlist and the **granted**
    /// scopes are unioned — a requested scope the Owner pruned is not added, and
    /// the row's name and `registered_at` survive.
    #[test]
    fn approve_oauth_consent_widens_a_changed_registration() {
        let store = FakeGatekeeperStore::default();
        let publisher = RecordingPublisher::default();
        let elsewhere =
            RegisteredRedirectUri::Absolute(url::Url::parse("https://other.example/cb").unwrap());
        let registered_at = Utc::now() - Duration::days(30);
        let mut existing = client("client", &["read"]);
        existing.redirect_uris = vec![elsewhere.clone()];
        existing.registered_at = registered_at;
        store.upsert_client(&existing).unwrap();
        let mut request = code_request(
            "req-1",
            RequestStatus::Pending,
            Utc::now() + Duration::minutes(5),
        );
        request.requested_scopes = vec!["read".to_owned(), "write".to_owned()];
        store.insert_authorization_request(&request).unwrap();

        approve_code(
            &store,
            &publisher,
            "req-1",
            approved(&["read"]),
            &owner_grant(),
            || "the-code".to_owned(),
        )
        .unwrap();

        let widened = store.client_by_id("client").unwrap().expect("client row");
        assert_eq!(
            widened.redirect_uris,
            vec![
                elsewhere,
                RegisteredRedirectUri::Absolute(url::Url::parse("https://example.com/cb").unwrap()),
            ],
        );
        // `write` was requested but pruned at consent, so it is NOT registered.
        assert_eq!(widened.allowed_scopes, vec!["read".to_owned()]);
        assert_eq!(widened.name, existing.name);
        assert_eq!(widened.registered_at, registered_at);
    }

    /// The clamp for a non-first-party client is `allowed_scopes ∪
    /// requested_scopes`: a scope outside the registration can be granted (that
    /// is what the warning is for) and is then unioned into the row, so the next
    /// identical request is `Registered`.
    #[test]
    fn approve_oauth_consent_may_grant_a_scope_outside_the_registration() {
        let store = FakeGatekeeperStore::default();
        let publisher = RecordingPublisher::default();
        store.upsert_client(&client("client", &["read"])).unwrap();
        let mut request = code_request(
            "req-1",
            RequestStatus::Pending,
            Utc::now() + Duration::minutes(5),
        );
        request.requested_scopes = vec!["write".to_owned()];
        store.insert_authorization_request(&request).unwrap();

        approve_code(
            &store,
            &publisher,
            "req-1",
            approved(&["write"]),
            &owner_grant(),
            || "the-code".to_owned(),
        )
        .unwrap();

        assert_eq!(
            store
                .grant_by_client_and_redirect(
                    "client",
                    &url::Url::parse("https://example.com/cb").unwrap(),
                )
                .unwrap()
                .expect("grant")
                .scopes,
            vec!["write".to_owned()],
        );
        assert_eq!(
            store
                .client_by_id("client")
                .unwrap()
                .unwrap()
                .allowed_scopes,
            vec!["read".to_owned(), "write".to_owned()],
        );
    }

    /// The first-party host is exempt from trust-on-first-use in both
    /// directions: its clamp is its registered `allowed_scopes` alone, so a
    /// requested-but-unregistered scope is pruned — and with nothing left to
    /// grant the approval lands as a deny, leaving its row untouched.
    #[test]
    fn approve_oauth_consent_clamps_the_first_party_client_to_its_registration() {
        let store = FakeGatekeeperStore::default();
        let publisher = RecordingPublisher::default();
        let host = client(crate::FIRST_PARTY_CLIENT_ID, &["read"]);
        store.upsert_client(&host).unwrap();
        let mut request = code_request(
            "req-1",
            RequestStatus::Pending,
            Utc::now() + Duration::minutes(5),
        );
        request.client_id = crate::FIRST_PARTY_CLIENT_ID.to_owned();
        request.requested_scopes = vec!["write".to_owned()];
        store.insert_authorization_request(&request).unwrap();

        let outcome = approve_code(
            &store,
            &publisher,
            "req-1",
            approved(&["write"]),
            &owner_grant(),
            || panic!("nothing is grantable, so no code is minted"),
        )
        .unwrap();
        assert_eq!(outcome, ConsentOutcome::Denied);
        assert_eq!(
            store
                .client_by_id(crate::FIRST_PARTY_CLIENT_ID)
                .unwrap()
                .unwrap(),
            host,
            "the first-party registration is never widened",
        );
    }

    #[test]
    fn approve_oauth_consent_maps_a_missing_request_to_not_found() {
        let store = FakeGatekeeperStore::default();
        let publisher = RecordingPublisher::default();
        assert_eq!(
            approve_code(
                &store,
                &publisher,
                "ghost",
                approved(&["read"]),
                &owner_grant(),
                || "unused".to_owned(),
            ),
            Err(GatekeeperError::OAuthConsentNotFound {
                id: "ghost".to_owned()
            }),
        );
    }

    #[test]
    fn approve_device_consent_expands_to_client_allowed_and_republishes() {
        let store = FakeGatekeeperStore::default();
        let publisher = RecordingPublisher::default();
        store
            .upsert_client(&client("client", &["openid", "read"]))
            .unwrap();
        store
            .insert_authorization_request(&device_request("dev-1", "UC-1", RequestStatus::Pending))
            .unwrap();
        let outcome = approve_device_consent(
            &store,
            &publisher,
            "UC-1",
            ApproveDeviceConsentInput {
                approved_scopes: vec!["read".to_owned()],
                patient: None,
                device_name: Some("My Phone".to_owned()),
            },
            &owner_grant(),
            Utc::now(),
        )
        .unwrap();
        assert_eq!(outcome, ConsentOutcome::Approved { redirect: None });
        let grant = store
            .device_grant_by_client_and_device_name("client", "My Phone")
            .unwrap()
            .expect("device grant");
        assert_eq!(grant.scopes, vec!["read".to_owned()]);
        assert_eq!(publisher.count(), 1);
    }

    #[test]
    fn deny_device_consent_marks_denied_and_republishes() {
        let store = FakeGatekeeperStore::default();
        let publisher = RecordingPublisher::default();
        store
            .insert_authorization_request(&device_request("dev-1", "UC-1", RequestStatus::Pending))
            .unwrap();
        deny_device_consent(&store, &publisher, "UC-1").unwrap();
        assert_eq!(
            store
                .authorization_request_by_id("dev-1")
                .unwrap()
                .unwrap()
                .status,
            RequestStatus::Denied,
        );
        assert_eq!(publisher.count(), 1);
        assert_eq!(
            deny_device_consent(&store, &publisher, "UNKNOWN"),
            Err(GatekeeperError::DeviceConsentNotFound {
                user_code: "UNKNOWN".to_owned()
            }),
        );
    }

    fn resource_scope_code_store(scope: &str) -> (FakeGatekeeperStore, RecordingPublisher) {
        let store = FakeGatekeeperStore::default();
        store.upsert_client(&client("client", &[scope])).unwrap();
        let mut request = code_request(
            "req-1",
            RequestStatus::Pending,
            Utc::now() + Duration::minutes(5),
        );
        request.requested_scopes = vec![scope.to_owned()];
        store.insert_authorization_request(&request).unwrap();
        (store, RecordingPublisher::default())
    }

    #[test]
    fn approve_oauth_consent_rejects_a_resource_scope_the_approver_cannot_delegate() {
        let (store, publisher) = resource_scope_code_store("system/Patient.r");
        let approver = Grant::parse(["system/Observation.r"]);
        let result = approve_code(
            &store,
            &publisher,
            "req-1",
            approved(&["system/Patient.r"]),
            &approver,
            || panic!("must not mint a code when the approver lacks authority"),
        );
        assert_eq!(
            result,
            Err(GatekeeperError::InsufficientApproverScope {
                missing_scopes: vec!["system/Patient.r".to_owned()],
            }),
        );
        assert_eq!(
            store
                .authorization_request_by_id("req-1")
                .unwrap()
                .unwrap()
                .status,
            RequestStatus::Pending,
        );
        assert_eq!(publisher.count(), 0);
    }

    #[test]
    fn approve_device_consent_rejects_a_resource_scope_the_approver_cannot_delegate() {
        let store = FakeGatekeeperStore::default();
        let publisher = RecordingPublisher::default();
        store
            .upsert_client(&client("client", &["system/Patient.r"]))
            .unwrap();
        store
            .insert_authorization_request(&device_request("dev-1", "UC-1", RequestStatus::Pending))
            .unwrap();
        let approver = Grant::parse(["system/Observation.r"]);
        let result = approve_device_consent(
            &store,
            &publisher,
            "UC-1",
            ApproveDeviceConsentInput {
                approved_scopes: vec!["system/Patient.r".to_owned()],
                patient: None,
                device_name: None,
            },
            &approver,
            Utc::now(),
        );
        assert_eq!(
            result,
            Err(GatekeeperError::InsufficientApproverScope {
                missing_scopes: vec!["system/Patient.r".to_owned()],
            }),
        );
        assert_eq!(publisher.count(), 0);
    }

    #[test]
    fn approve_device_consent_allows_a_resource_scope_the_approver_holds() {
        let store = FakeGatekeeperStore::default();
        let publisher = RecordingPublisher::default();
        store
            .upsert_client(&client("client", &["system/Patient.r"]))
            .unwrap();
        store
            .insert_authorization_request(&device_request("dev-1", "UC-1", RequestStatus::Pending))
            .unwrap();
        let approver = Grant::parse(["system/*.cruds"]);
        let outcome = approve_device_consent(
            &store,
            &publisher,
            "UC-1",
            ApproveDeviceConsentInput {
                approved_scopes: vec!["system/Patient.r".to_owned()],
                patient: None,
                device_name: Some("My Phone".to_owned()),
            },
            &approver,
            Utc::now(),
        )
        .unwrap();
        assert_eq!(outcome, ConsentOutcome::Approved { redirect: None });
    }

    #[test]
    fn load_pending_code_request_accepts_a_live_request_and_refuses_the_rest() {
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

        // Denied / expired / wrong-flow / unknown → OAuthConsentNotFound.
        store
            .insert_authorization_request(&code_request(
                "expired",
                RequestStatus::Pending,
                Utc::now() - Duration::minutes(1),
            ))
            .unwrap();
        for id in ["expired", "ghost"] {
            assert_eq!(
                load_pending_authorization_code_request(&store, id),
                Err(GatekeeperError::OAuthConsentNotFound { id: id.to_owned() }),
            );
        }
    }

    #[test]
    fn upsert_authorization_code_grant_inserts_then_unions_scopes() {
        let store = FakeGatekeeperStore::default();
        let redirect = url::Url::parse("https://example.com/cb").unwrap();

        upsert_authorization_code_grant(
            &store,
            "client-a",
            &redirect,
            &["read".to_owned()],
            Some("pat-1"),
            Utc::now(),
            &RegistrationWrite::Untouched,
        )
        .unwrap();
        let first = store
            .grant_by_client_and_redirect("client-a", &redirect)
            .unwrap()
            .expect("grant inserted");
        assert_eq!(first.scopes, vec!["read".to_owned()]);

        upsert_authorization_code_grant(
            &store,
            "client-a",
            &redirect,
            &["read".to_owned(), "write".to_owned()],
            Some("pat-2"),
            Utc::now(),
            &RegistrationWrite::Untouched,
        )
        .unwrap();
        let merged = store
            .grant_by_client_and_redirect("client-a", &redirect)
            .unwrap()
            .expect("grant present");
        assert_eq!(
            merged.id, first.id,
            "the same grant is updated, not duplicated"
        );
        assert_eq!(merged.scopes, vec!["read".to_owned(), "write".to_owned()]);
        assert_eq!(merged.patient.as_deref(), Some("pat-2"));
    }

    #[test]
    fn consent_reader_oauth_consent_resolves_the_client_name() {
        let store = FakeGatekeeperStore::default();
        store.upsert_client(&client("client", &["read"])).unwrap();
        store
            .insert_authorization_request(&code_request(
                "req-1",
                RequestStatus::Pending,
                Utc::now() + Duration::minutes(5),
            ))
            .unwrap();
        let reader = ConsentReader::new(
            store,
            Arc::new(NoSelfHostedRedirects),
            crate::FIRST_PARTY_CLIENT_ID.into(),
        );
        let view = reader
            .oauth_consent("req-1", "http://127.0.0.1")
            .expect("view");
        assert_eq!(view.request.id, "req-1");
        assert_eq!(view.redirect_uri.as_str(), "https://example.com/cb");
    }
}
