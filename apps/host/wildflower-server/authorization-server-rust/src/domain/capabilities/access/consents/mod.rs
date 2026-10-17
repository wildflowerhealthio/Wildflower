//! Consent capabilities — the `wildflower/AuthorizationRequest.*` capabilities
//! behind `/authorization/oauth-consents/*` and `/authorization/devices/*`. The flows
//! (load-and-validate, approve, deny) are `&impl GrantStore` functions in
//! the submodules; an approval's privileged writes go through the
//! [`writers`](crate::domain::capabilities::writers) under the
//! [`DelegatedScopes`](crate::domain::authority::DelegatedScopes) proof it
//! obtains, so what the Owner clicked is never recorded wider than what the
//! Owner holds.
//!
//! The code-flow surfaces also carry the **registration verdict** (see
//! [`crate::domain::client_registration`]).
//!
//! Approving a code-flow or device-flow request takes the power to create what
//! the approval creates, the [`approval_scopes`]: `wildflower/Grant.c` for the
//! standing grant, and for a code-flow request `wildflower/Client.c` or
//! `wildflower/Client.u` when it registers or widens its client. The required
//! scopes depend on the request, so [`ConsentDecider`] is a data-dependent
//! capability: it holds the approver's [`Grant`] and checks them per call, and
//! [`ConsentReader`] reports the ones its caller lacks with the prompt.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use wildflowerhealthio_scope_capabilities::MissingScopes;
use wildflowerhealthio_scopes::{render_scopes, Grant, Permission, Scope, WildflowerResource};

use crate::domain::authorization_request::{AuthorizationRequest, GrantType};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::client_registration::{
    classify_registration, ClientRegistrationVerdict, PresentedClientRegistration,
};
use crate::domain::GrantStore;
use crate::ports::OwnerApproval;

mod delegation;
mod device;
mod oauth;

use device::{approve_device_consent, deny_device_consent, load_pending_request_by_user_code};
use oauth::{
    approve_oauth_consent, deny_oauth_consent, load_pending_code_request, ApprovalContext,
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

/// The scope approving a code-flow or device-flow request also takes, for the
/// standing grant the approval records — `wildflower/Grant.c`.
pub(crate) fn grant_creating_approval_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Grant,
        Permission::CREATE,
    )]
}

/// The scope approving a code-flow request from a
/// [`New`](ClientRegistrationVerdict::New) client also takes, for the
/// registration the approval creates — `wildflower/Client.c`.
pub(crate) fn client_creating_approval_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Client,
        Permission::CREATE,
    )]
}

/// The scope approving a code-flow request that
/// [`WouldWiden`](ClientRegistrationVerdict::WouldWiden) its client's
/// registration also takes, for the widening — `wildflower/Client.u`.
pub(crate) fn client_widening_approval_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Client,
        Permission::UPDATE,
    )]
}

/// The **approval scopes**: what an approver must hold to approve a code-flow
/// or device-flow request, the power to create what the approval creates.
/// [`consent_decider_scopes`] to decide it at all, and
/// [`grant_creating_approval_scopes`] for the standing grant every such
/// approval records. The client registration `registration_to_widen` names
/// adds [`client_creating_approval_scopes`] when it is
/// [`New`](ClientRegistrationVerdict::New) and
/// [`client_widening_approval_scopes`] when it
/// [`WouldWiden`](ClientRegistrationVerdict::WouldWiden); `None` (a device
/// request, or a fixed registration) and a
/// [`Registered`](ClientRegistrationVerdict::Registered) verdict add nothing.
///
/// A browser pairing records no grant and registers no client, so approving
/// one takes [`consent_decider_scopes`] alone.
pub(crate) fn approval_scopes(
    registration_to_widen: Option<&ClientRegistrationVerdict>,
) -> Vec<Scope> {
    let registration_scopes = match registration_to_widen {
        None | Some(ClientRegistrationVerdict::Registered) => Vec::new(),
        Some(ClientRegistrationVerdict::New) => client_creating_approval_scopes(),
        Some(ClientRegistrationVerdict::WouldWiden { .. }) => client_widening_approval_scopes(),
    };
    [
        consent_decider_scopes(),
        grant_creating_approval_scopes(),
        registration_scopes,
    ]
    .concat()
}

/// The [`approval_scopes`] for `registration_to_widen` that `approver_grant`
/// does not cover, in their order; empty when it may approve.
pub(crate) fn missing_approval_scopes(
    approver_grant: &Grant,
    registration_to_widen: Option<&ClientRegistrationVerdict>,
) -> Vec<Scope> {
    approval_scopes(registration_to_widen)
        .into_iter()
        .filter(|required| !approver_grant.covers(required))
        .collect()
}

/// Refuse an approval whose approver lacks any of its [`approval_scopes`]:
/// the one check both approve paths run before anything is written.
///
/// # Errors
///
/// [`AuthorizationServerError::InsufficientScope`] naming the
/// [`missing_approval_scopes`].
fn require_approval_scopes(
    approver_grant: &Grant,
    registration_to_widen: Option<&ClientRegistrationVerdict>,
) -> Result<(), AuthorizationServerError> {
    let missing = missing_approval_scopes(approver_grant, registration_to_widen);
    if missing.is_empty() {
        Ok(())
    } else {
        Err(MissingScopes::uncovered(&missing).into())
    }
}

/// The client registration approving a code-flow request for `client_id`
/// would create or widen, as its `registration_verdict` says: `None` for the
/// host app's client, whose registration is fixed.
pub(crate) fn registration_to_widen<'verdict>(
    client_id: &str,
    wildflower_host_app_client_id: &str,
    registration_verdict: &'verdict ClientRegistrationVerdict,
) -> Option<&'verdict ClientRegistrationVerdict> {
    (client_id != wildflower_host_app_client_id).then_some(registration_verdict)
}

// ---------------------------------------------------------------------------
// Read models the consent pages render — the shapes the `GET` consent
// handlers return. Pure domain data (no axum), produced by `ConsentReader`.
// ---------------------------------------------------------------------------

/// A consent prompt loaded for the launcher or the host to render — the data a
/// `GET` authorization-code consent handler needs, with the client's display
/// name and its [registration verdict](ClientRegistrationVerdict) already
/// resolved.
pub struct OAuthConsentView {
    pub request: AuthorizationRequest,
    pub requested_redirect_uri: url::Url,
    pub client_name: String,
    /// How this request compares against the client's registration **as it
    /// stands now** — the warning the prompt leads with when the app, its
    /// redirect, or its scopes are new to the Owner. Recomputed on every read,
    /// never stored.
    pub registration_verdict: ClientRegistrationVerdict,
    /// The [`approval_scopes`] the reader's own grant does not cover, rendered:
    /// what it lacks to approve this request. Empty when it may approve.
    pub missing_approval_scopes: Vec<String>,
}

/// A device-page consent prompt (a device-code request or a browser pairing)
/// loaded for the launcher or the host — adds the expansion envelope the
/// approver may grant up to: a device client's full `allowed_scopes`, or for a
/// browser pairing the Owner's scopes.
pub struct DeviceConsentView {
    pub request: AuthorizationRequest,
    pub client_name: String,
    pub approvable_scopes: Vec<String>,
}

// ---------------------------------------------------------------------------
// Decision inputs / outcome.
// ---------------------------------------------------------------------------

/// The Owner's decision on a consent prompt, after the action has applied it.
#[derive(Debug, PartialEq, Eq)]
pub enum ConsentOutcome {
    /// Approved. `redirect` is the client callback URL carrying the code, to
    /// hand back so the approving surface can finish the flow inline (code
    /// flow with a `client_state`); `None` for the device flow.
    Approved { redirect: Option<String> },
    /// Denied, or nothing was granted (no requested-and-allowed scope was
    /// approved, which is applied as a deny). `redirect` is the client callback
    /// URL carrying `error=access_denied` (code flow with a `client_state`);
    /// `None` for the device flow.
    Denied { redirect: Option<String> },
}

/// The Owner's approval of an authorization-code consent prompt.
pub struct ApproveOAuthConsentInput {
    /// The scopes the Owner ticked.
    pub owner_approved_scopes: Vec<String>,
    /// Optional SMART-on-FHIR patient context to bind to the grant. When the
    /// request's SMART launch bound a patient, it must be that patient, or the
    /// approval fails with [`AuthorizationServerError::LaunchPatientMismatch`].
    pub patient: Option<String>,
    /// The Owner's explicit acknowledgement that they recognise this app and
    /// its redirect address. Required when the
    /// [registration verdict](ClientRegistrationVerdict) is
    /// [`New`](ClientRegistrationVerdict::New) or
    /// [`WouldWiden`](ClientRegistrationVerdict::WouldWiden) — approving without it fails
    /// with [`AuthorizationServerError::RegistrationNotAcknowledged`]. Ignored for a
    /// [`Registered`](ClientRegistrationVerdict::Registered) request, which shows no
    /// warning to acknowledge.
    pub acknowledged_registration: bool,
}

/// The Owner's approval of a device-code consent prompt.
pub struct ApproveDeviceConsentInput {
    /// The scopes the Owner ticked.
    pub owner_approved_scopes: Vec<String>,
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
/// `/authorization/oauth-consents/{id}` and `/authorization/devices/{userCode}`.
/// Statically gated by `AuthorizationRequest.r`, and it additionally holds the
/// caller's own [`Grant`], to say which [`approval_scopes`] a code-flow prompt
/// takes that the caller lacks.
pub(crate) struct ConsentReader<S: GrantStore> {
    store: S,
    reader_grant: Grant,
    wildflower_host_app_client_id: Arc<str>,
}

impl<S: GrantStore> ConsentReader<S> {
    /// Build the reader over a store handle, the reader's own granted scopes,
    /// and the host app's `client_id` (whose registration is fixed, so
    /// approving its requests widens nothing) — all lifted from the state +
    /// claims.
    pub(crate) fn new(
        store: S,
        reader_grant: Grant,
        wildflower_host_app_client_id: Arc<str>,
    ) -> Self {
        ConsentReader {
            store,
            reader_grant,
            wildflower_host_app_client_id,
        }
    }

    /// Load a pending authorization-code consent prompt for the launcher, with
    /// the client's display name and its registration verdict resolved against
    /// the current row, and the approval scopes the reader lacks.
    pub(crate) fn oauth_consent(
        &self,
        id: &str,
    ) -> Result<OAuthConsentView, AuthorizationServerError> {
        let pending_request = load_pending_code_request(&self.store, id)?;
        let requested_redirect_uri = pending_request.redirect_uri().clone();
        let request = pending_request.into_request();
        // A missing row is the `New` verdict, and its name falls back to the raw
        // `client_id`. A store failure fails the read.
        let maybe_existing_client = self.store.client_by_id(&request.client_id)?;
        let client_name = maybe_existing_client.as_ref().map_or_else(
            || request.client_id.clone(),
            |existing_client| existing_client.name.clone(),
        );
        let registration_verdict = classify_registration(&PresentedClientRegistration {
            maybe_existing_client: maybe_existing_client.as_ref(),
            redirect_uri: &requested_redirect_uri,
            scopes: &request.requested_scopes,
        });
        let missing_approval_scopes = render_scopes(&missing_approval_scopes(
            &self.reader_grant,
            registration_to_widen(
                &request.client_id,
                &self.wildflower_host_app_client_id,
                &registration_verdict,
            ),
        ));
        Ok(OAuthConsentView {
            request,
            requested_redirect_uri,
            client_name,
            registration_verdict,
            missing_approval_scopes,
        })
    }

    /// Load a pending device-page consent prompt for the launcher, with the
    /// client's name and expansion envelope resolved.
    pub(crate) fn device_consent(
        &self,
        user_code: &str,
    ) -> Result<DeviceConsentView, AuthorizationServerError> {
        let request = load_pending_request_by_user_code(&self.store, user_code)?;
        let (client_name, registered_client_scopes) =
            match self.store.client_by_id(&request.client_id)? {
                Some(existing_client) => (existing_client.name, existing_client.allowed_scopes),
                None => (request.client_id.clone(), Vec::new()),
            };
        let approvable_scopes = match request.grant_type {
            GrantType::BrowserPairing => crate::owner_scopes(),
            GrantType::AuthorizationCode | GrantType::DeviceCode => registered_client_scopes,
        };
        Ok(DeviceConsentView {
            request,
            client_name,
            approvable_scopes,
        })
    }
}

/// Decide (approve/deny) pending consent prompts — the `approve`/`deny` sides of
/// both consent surfaces. Statically gated by `AuthorizationRequest.u`, and it
/// additionally holds the caller's own [`Grant`] (the approve paths require the
/// request's [`approval_scopes`] and reject any delegation beyond the
/// approver's authority) plus the [`OwnerApproval`] port — both lifted from
/// the state.
pub(crate) struct ConsentDecider<S: GrantStore> {
    store: S,
    owner_approval: Arc<dyn OwnerApproval>,
    approver_grant: Grant,
    wildflower_host_app_client_id: Arc<str>,
}

impl<S: GrantStore> ConsentDecider<S> {
    /// Build the decider over a store handle, the republish port, the approver's
    /// own granted scopes, and the host app's `client_id` — all lifted from the
    /// state + claims. The last decides which client's registration is fixed
    /// when a code-flow approval is checked against its
    /// [registration verdict](ClientRegistrationVerdict).
    pub(crate) fn new(
        store: S,
        owner_approval: Arc<dyn OwnerApproval>,
        approver_grant: Grant,
        wildflower_host_app_client_id: Arc<str>,
    ) -> Self {
        ConsentDecider {
            store,
            owner_approval,
            approver_grant,
            wildflower_host_app_client_id,
        }
    }

    /// Approve an authorization-code consent; an approver lacking one of its
    /// [`approval_scopes`], or a resource scope beyond the approver's own
    /// authority, fails the approval with a `403`, and an
    /// unacknowledged [`New`](ClientRegistrationVerdict::New) /
    /// [`WouldWiden`](ClientRegistrationVerdict::WouldWiden) registration fails it with a
    /// `409`.
    pub(crate) fn approve_oauth(
        &self,
        id: &str,
        input: ApproveOAuthConsentInput,
        generate_code: impl FnOnce() -> String,
        now: DateTime<Utc>,
    ) -> Result<ConsentOutcome, AuthorizationServerError> {
        approve_oauth_consent(
            &self.store,
            self.owner_approval.as_ref(),
            id,
            input,
            generate_code,
            &ApprovalContext {
                approver_grant: &self.approver_grant,
                wildflower_host_app_client_id: &self.wildflower_host_app_client_id,
                now,
            },
        )
    }

    /// Deny an authorization-code consent, returning the client's
    /// `error=access_denied` callback.
    pub(crate) fn deny_oauth(&self, id: &str) -> Result<ConsentOutcome, AuthorizationServerError> {
        deny_oauth_consent(&self.store, self.owner_approval.as_ref(), id)
    }

    /// Approve a device-page consent; an approver lacking one of a device
    /// request's [`approval_scopes`], or a resource scope beyond the approver's
    /// own authority, fails the approval with a `403`.
    pub(crate) fn approve_device(
        &self,
        user_code: &str,
        input: ApproveDeviceConsentInput,
        now: DateTime<Utc>,
    ) -> Result<ConsentOutcome, AuthorizationServerError> {
        approve_device_consent(
            &self.store,
            self.owner_approval.as_ref(),
            user_code,
            input,
            &self.approver_grant,
            now,
        )
    }

    /// Deny a device-code consent.
    pub(crate) fn deny_device(&self, user_code: &str) -> Result<(), AuthorizationServerError> {
        deny_device_consent(&self.store, self.owner_approval.as_ref(), user_code)
    }
}

#[cfg(test)]
mod tests {

    use chrono::Duration;

    use super::*;
    use crate::domain::authorization_request::{AuthorizationRequest, RequestStatus};
    use crate::domain::test_fake::{
        client, code_request, device_request, seed_fixture_browser_session, FakeGrantStore,
        RecordingOwnerApproval,
    };

    /// Approve a code-flow consent with the real
    /// host app's client id — which the `client` fixture never uses, so the fixture
    /// client always takes the trust-on-first-use path.
    fn approve_code(
        store: &FakeGrantStore,
        owner_approval: &RecordingOwnerApproval,
        id: &str,
        input: ApproveOAuthConsentInput,
        approver_grant: &Grant,
        generate_code: impl FnOnce() -> String,
    ) -> Result<ConsentOutcome, AuthorizationServerError> {
        approve_oauth_consent(
            store,
            owner_approval,
            id,
            input,
            generate_code,
            &ApprovalContext {
                approver_grant,
                wildflower_host_app_client_id: crate::WILDFLOWER_HOST_APP_CLIENT_ID,
                now: Utc::now(),
            },
        )
    }

    /// An approval of everything requested, acknowledged — the common input.
    fn approved(scopes: &[&str]) -> ApproveOAuthConsentInput {
        ApproveOAuthConsentInput {
            owner_approved_scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
            patient: None,
            acknowledged_registration: true,
        }
    }

    /// An owner-equivalent approver grant — the two universal resource wildcards.
    fn owner_grant() -> Grant {
        Grant::parse(["wildflower/*.cruds", "system/*.cruds"])
    }

    /// An approved browser's grant: it decides requests and creates grants
    /// (the approval scopes of a request that registers no client), plus
    /// `resource_scopes`.
    fn approver_grant_with(resource_scopes: &[&str]) -> Grant {
        Grant::parse(
            ["wildflower/AuthorizationRequest.u", "wildflower/Grant.c"]
                .iter()
                .chain(resource_scopes),
        )
    }

    fn live_code_store() -> (FakeGrantStore, RecordingOwnerApproval) {
        let store = FakeGrantStore::default();
        seed_fixture_browser_session(&store);
        store.upsert_client(&client("client", &["read"])).unwrap();
        store
            .insert_authorization_request(&code_request(
                "req-1",
                RequestStatus::Pending,
                Utc::now() + Duration::minutes(5),
            ))
            .unwrap();
        (store, RecordingOwnerApproval::default())
    }

    #[test]
    fn approve_oauth_consent_mints_a_code_and_returns_the_redirect() {
        let (store, owner_approval) = live_code_store();
        let outcome = approve_code(
            &store,
            &owner_approval,
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
        // The approval moved this request out of `pending`, so the popup head
        // has to be recomputed — the queue spans both grant flows, so a
        // code-flow approval is as much a head transition as a device one.
        assert_eq!(owner_approval.count(), 1);
    }

    #[test]
    fn approve_oauth_consent_with_nothing_granted_is_a_deny() {
        let (store, owner_approval) = live_code_store();
        let outcome = approve_code(
            &store,
            &owner_approval,
            "req-1",
            approved(&["write"]),
            &owner_grant(),
            || panic!("must not mint a code on a deny"),
        )
        .unwrap();
        assert_eq!(
            outcome,
            ConsentOutcome::Denied {
                redirect: Some("https://example.com/cb?error=access_denied&state=state".to_owned()),
            }
        );
        assert_eq!(
            store
                .authorization_request_by_id("req-1")
                .unwrap()
                .unwrap()
                .status,
            RequestStatus::Denied,
        );
        assert_eq!(owner_approval.count(), 1);
    }

    /// A request whose SMART launch bound a patient is approved only for that
    /// patient: another patient, or none, is refused and writes nothing (no
    /// code, no grant, still pending); the launch's own patient goes through
    /// and is bound to the code.
    #[test]
    fn approve_oauth_consent_requires_the_launch_bound_patient() {
        let (store, owner_approval) = live_code_store();
        store
            .insert_authorization_request(&AuthorizationRequest {
                launch: Some("launch-1".to_owned()),
                launch_bound_patient: Some("pat-1".to_owned()),
                ..code_request(
                    "req-1",
                    RequestStatus::Pending,
                    Utc::now() + Duration::minutes(5),
                )
            })
            .unwrap();
        for patient in [Some("pat-2"), None] {
            let result = approve_code(
                &store,
                &owner_approval,
                "req-1",
                ApproveOAuthConsentInput {
                    patient: patient.map(str::to_owned),
                    ..approved(&["read"])
                },
                &owner_grant(),
                || panic!("must not mint a code for another patient"),
            );
            assert_eq!(
                result,
                Err(AuthorizationServerError::LaunchPatientMismatch {
                    id: "req-1".to_owned()
                }),
                "approving for {patient:?}",
            );
        }
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

        approve_code(
            &store,
            &owner_approval,
            "req-1",
            ApproveOAuthConsentInput {
                patient: Some("pat-1".to_owned()),
                ..approved(&["read"])
            },
            &owner_grant(),
            || "the-code".to_owned(),
        )
        .expect("the launch's own patient is approved");
        assert_eq!(
            store
                .authorization_code_by_request_id("req-1")
                .unwrap()
                .expect("a code")
                .patient
                .as_deref(),
            Some("pat-1"),
        );
    }

    /// A client this authorization server has never seen reaches consent (nothing is
    /// registered at `/authorize`), and approving it **without** the Owner's
    /// acknowledgement writes nothing at all: no client row, no grant, no code,
    /// and the prompt stays pending so they can decide again.
    #[test]
    fn approve_oauth_consent_rejects_an_unacknowledged_new_client() {
        let store = FakeGrantStore::default();
        let owner_approval = RecordingOwnerApproval::default();
        store
            .insert_authorization_request(&code_request(
                "req-1",
                RequestStatus::Pending,
                Utc::now() + Duration::minutes(5),
            ))
            .unwrap();
        let result = approve_code(
            &store,
            &owner_approval,
            "req-1",
            ApproveOAuthConsentInput {
                owner_approved_scopes: vec!["read".to_owned()],
                patient: None,
                acknowledged_registration: false,
            },
            &owner_grant(),
            || panic!("must not mint a code for an unacknowledged registration"),
        );
        assert_eq!(
            result,
            Err(AuthorizationServerError::RegistrationNotAcknowledged {
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
        let store = FakeGrantStore::default();
        seed_fixture_browser_session(&store);
        let owner_approval = RecordingOwnerApproval::default();
        store
            .insert_authorization_request(&code_request(
                "req-1",
                RequestStatus::Pending,
                Utc::now() + Duration::minutes(5),
            ))
            .unwrap();
        approve_code(
            &store,
            &owner_approval,
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
            vec![url::Url::parse("https://example.com/cb").unwrap()],
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
        let store = FakeGrantStore::default();
        seed_fixture_browser_session(&store);
        let owner_approval = RecordingOwnerApproval::default();
        let elsewhere = url::Url::parse("https://other.example/cb").unwrap();
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
            &owner_approval,
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
                url::Url::parse("https://example.com/cb").unwrap(),
            ],
        );
        // `write` was requested but pruned at consent, so it is NOT registered.
        assert_eq!(widened.allowed_scopes, vec!["read".to_owned()]);
        assert_eq!(widened.name, existing.name);
        assert_eq!(widened.registered_at, registered_at);
    }

    /// The clamp for a client trusted on first use is `allowed_scopes ∪
    /// requested_scopes`: a scope outside the registration can be granted (that
    /// is what the warning is for) and is then unioned into the row, so the next
    /// identical request is `Registered`.
    #[test]
    fn approve_oauth_consent_may_grant_a_scope_outside_the_registration() {
        let store = FakeGrantStore::default();
        seed_fixture_browser_session(&store);
        let owner_approval = RecordingOwnerApproval::default();
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
            &owner_approval,
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

    /// A fixed registration is exempt from trust-on-first-use in both
    /// directions: its clamp is its registered `allowed_scopes` alone, so a
    /// requested-but-unregistered scope is pruned — and with nothing left to
    /// grant the approval lands as a deny, leaving its row untouched.
    #[test]
    fn approve_oauth_consent_clamps_a_fixed_registration_to_itself() {
        let store = FakeGrantStore::default();
        let owner_approval = RecordingOwnerApproval::default();
        let host = client(crate::WILDFLOWER_HOST_APP_CLIENT_ID, &["read"]);
        store.upsert_client(&host).unwrap();
        let mut request = code_request(
            "req-1",
            RequestStatus::Pending,
            Utc::now() + Duration::minutes(5),
        );
        request.client_id = crate::WILDFLOWER_HOST_APP_CLIENT_ID.to_owned();
        request.requested_scopes = vec!["write".to_owned()];
        store.insert_authorization_request(&request).unwrap();

        let outcome = approve_code(
            &store,
            &owner_approval,
            "req-1",
            approved(&["write"]),
            &owner_grant(),
            || panic!("nothing is grantable, so no code is minted"),
        )
        .unwrap();
        assert!(matches!(outcome, ConsentOutcome::Denied { .. }));
        assert_eq!(
            store
                .client_by_id(crate::WILDFLOWER_HOST_APP_CLIENT_ID)
                .unwrap()
                .unwrap(),
            host,
            "the fixed registration is never widened",
        );
    }

    #[test]
    fn approve_oauth_consent_maps_a_missing_request_to_not_found() {
        let store = FakeGrantStore::default();
        let owner_approval = RecordingOwnerApproval::default();
        assert_eq!(
            approve_code(
                &store,
                &owner_approval,
                "ghost",
                approved(&["read"]),
                &owner_grant(),
                || "unused".to_owned(),
            ),
            Err(AuthorizationServerError::OAuthConsentNotFound {
                id: "ghost".to_owned()
            }),
        );
    }

    #[test]
    fn approve_device_consent_expands_to_client_allowed_and_republishes() {
        let store = FakeGrantStore::default();
        let owner_approval = RecordingOwnerApproval::default();
        store
            .upsert_client(&client("client", &["openid", "read"]))
            .unwrap();
        store
            .insert_authorization_request(&device_request("dev-1", "UC-1", RequestStatus::Pending))
            .unwrap();
        let outcome = approve_device_consent(
            &store,
            &owner_approval,
            "UC-1",
            ApproveDeviceConsentInput {
                owner_approved_scopes: vec!["read".to_owned()],
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
        assert_eq!(owner_approval.count(), 1);
    }

    #[test]
    fn deny_device_consent_marks_denied_and_republishes() {
        let store = FakeGrantStore::default();
        let owner_approval = RecordingOwnerApproval::default();
        store
            .insert_authorization_request(&device_request("dev-1", "UC-1", RequestStatus::Pending))
            .unwrap();
        deny_device_consent(&store, &owner_approval, "UC-1").unwrap();
        assert_eq!(
            store
                .authorization_request_by_id("dev-1")
                .unwrap()
                .unwrap()
                .status,
            RequestStatus::Denied,
        );
        assert_eq!(owner_approval.count(), 1);
        assert_eq!(
            deny_device_consent(&store, &owner_approval, "UNKNOWN"),
            Err(AuthorizationServerError::DeviceConsentNotFound {
                user_code: "UNKNOWN".to_owned()
            }),
        );
    }

    fn resource_scope_code_store(scope: &str) -> (FakeGrantStore, RecordingOwnerApproval) {
        let store = FakeGrantStore::default();
        seed_fixture_browser_session(&store);
        store.upsert_client(&client("client", &[scope])).unwrap();
        let mut request = code_request(
            "req-1",
            RequestStatus::Pending,
            Utc::now() + Duration::minutes(5),
        );
        request.requested_scopes = vec![scope.to_owned()];
        store.insert_authorization_request(&request).unwrap();
        (store, RecordingOwnerApproval::default())
    }

    #[test]
    fn approve_oauth_consent_rejects_a_resource_scope_the_approver_cannot_delegate() {
        let (store, owner_approval) = resource_scope_code_store("system/Patient.r");
        let approver_grant = approver_grant_with(&["system/Observation.r"]);
        let result = approve_code(
            &store,
            &owner_approval,
            "req-1",
            approved(&["system/Patient.r"]),
            &approver_grant,
            || panic!("must not mint a code when the approver lacks authority"),
        );
        assert_eq!(
            result,
            Err(AuthorizationServerError::InsufficientApproverScope {
                approver_missing_scopes: vec!["system/Patient.r".to_owned()],
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
        assert_eq!(owner_approval.count(), 0);
    }

    #[test]
    fn approve_device_consent_rejects_a_resource_scope_the_approver_cannot_delegate() {
        let store = FakeGrantStore::default();
        let owner_approval = RecordingOwnerApproval::default();
        store
            .upsert_client(&client("client", &["system/Patient.r"]))
            .unwrap();
        store
            .insert_authorization_request(&device_request("dev-1", "UC-1", RequestStatus::Pending))
            .unwrap();
        let approver_grant = approver_grant_with(&["system/Observation.r"]);
        let result = approve_device_consent(
            &store,
            &owner_approval,
            "UC-1",
            ApproveDeviceConsentInput {
                owner_approved_scopes: vec!["system/Patient.r".to_owned()],
                patient: None,
                device_name: None,
            },
            &approver_grant,
            Utc::now(),
        );
        assert_eq!(
            result,
            Err(AuthorizationServerError::InsufficientApproverScope {
                approver_missing_scopes: vec!["system/Patient.r".to_owned()],
            }),
        );
        assert_eq!(owner_approval.count(), 0);
    }

    #[test]
    fn approve_device_consent_allows_a_resource_scope_the_approver_holds() {
        let store = FakeGrantStore::default();
        let owner_approval = RecordingOwnerApproval::default();
        store
            .upsert_client(&client("client", &["system/Patient.r"]))
            .unwrap();
        store
            .insert_authorization_request(&device_request("dev-1", "UC-1", RequestStatus::Pending))
            .unwrap();
        let approver_grant = approver_grant_with(&["system/*.cruds"]);
        let outcome = approve_device_consent(
            &store,
            &owner_approval,
            "UC-1",
            ApproveDeviceConsentInput {
                owner_approved_scopes: vec!["system/Patient.r".to_owned()],
                patient: None,
                device_name: Some("My Phone".to_owned()),
            },
            &approver_grant,
            Utc::now(),
        )
        .unwrap();
        assert_eq!(outcome, ConsentOutcome::Approved { redirect: None });
    }

    /// The approval scopes follow what the approval creates: a standing grant
    /// always, a registration for a new client, a widening for a changed one.
    #[test]
    fn approval_scopes_follow_what_the_approval_creates() {
        let widened = ClientRegistrationVerdict::WouldWiden {
            redirect_uri_is_new: true,
            unregistered_requested_scopes: Vec::new(),
        };
        for (registration_to_widen, expected) in [
            (
                None,
                &["wildflower/AuthorizationRequest.u", "wildflower/Grant.c"][..],
            ),
            (
                Some(&ClientRegistrationVerdict::Registered),
                &["wildflower/AuthorizationRequest.u", "wildflower/Grant.c"][..],
            ),
            (
                Some(&ClientRegistrationVerdict::New),
                &[
                    "wildflower/AuthorizationRequest.u",
                    "wildflower/Grant.c",
                    "wildflower/Client.c",
                ][..],
            ),
            (
                Some(&widened),
                &[
                    "wildflower/AuthorizationRequest.u",
                    "wildflower/Grant.c",
                    "wildflower/Client.u",
                ][..],
            ),
        ] {
            assert_eq!(
                render_scopes(&approval_scopes(registration_to_widen)),
                expected,
                "{registration_to_widen:?}"
            );
        }
    }

    /// An Owner session holds `OWNER_SCOPES`, which cover every approval
    /// scope, so approving asks nothing more of it.
    #[test]
    fn the_owner_s_scopes_cover_every_approval_scope() {
        let owner_session_grant = Grant::parse(crate::owner_scopes());
        let widened = ClientRegistrationVerdict::WouldWiden {
            redirect_uri_is_new: false,
            unregistered_requested_scopes: vec!["patient/Observation.rs".to_owned()],
        };
        for registration_to_widen in [
            None,
            Some(&ClientRegistrationVerdict::Registered),
            Some(&ClientRegistrationVerdict::New),
            Some(&widened),
        ] {
            assert_eq!(
                missing_approval_scopes(&owner_session_grant, registration_to_widen),
                Vec::<Scope>::new(),
                "{registration_to_widen:?}"
            );
        }
    }

    /// An approved browser deciding requests and creating grants approves a
    /// registered app within its own scopes.
    #[test]
    fn an_approver_creating_grants_approves_a_registered_app() {
        let (store, owner_approval) = resource_scope_code_store("system/Patient.r");
        let outcome = approve_code(
            &store,
            &owner_approval,
            "req-1",
            approved(&["system/Patient.r"]),
            &approver_grant_with(&["system/Patient.r"]),
            || "the-code".to_owned(),
        )
        .unwrap();
        assert!(matches!(outcome, ConsentOutcome::Approved { .. }));
    }

    /// Without `wildflower/Grant.c` an approval of a code request is refused
    /// whole, naming it, and writes nothing.
    #[test]
    fn approve_oauth_consent_requires_creating_the_grant() {
        let (store, owner_approval) = resource_scope_code_store("system/Patient.r");
        let result = approve_code(
            &store,
            &owner_approval,
            "req-1",
            approved(&["system/Patient.r"]),
            &Grant::parse(["wildflower/AuthorizationRequest.u", "system/Patient.r"]),
            || panic!("must not mint a code without the power to create the grant"),
        );
        assert_eq!(
            result,
            Err(AuthorizationServerError::InsufficientScope {
                missing_scopes: vec!["wildflower/Grant.c".to_owned()],
            }),
        );
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
        assert_eq!(owner_approval.count(), 0);
    }

    /// Registering a new client takes `wildflower/Client.c`: without it the
    /// acknowledged approval is refused, naming it, and no client row is
    /// written; with it the client is registered.
    #[test]
    fn approve_oauth_consent_requires_creating_a_new_client() {
        let store = FakeGrantStore::default();
        seed_fixture_browser_session(&store);
        let owner_approval = RecordingOwnerApproval::default();
        store
            .insert_authorization_request(&code_request(
                "req-1",
                RequestStatus::Pending,
                Utc::now() + Duration::minutes(5),
            ))
            .unwrap();

        let result = approve_code(
            &store,
            &owner_approval,
            "req-1",
            approved(&["read"]),
            &approver_grant_with(&[]),
            || panic!("must not mint a code without the power to register the client"),
        );
        assert_eq!(
            result,
            Err(AuthorizationServerError::InsufficientScope {
                missing_scopes: vec!["wildflower/Client.c".to_owned()],
            }),
        );
        assert!(store.client_by_id("client").unwrap().is_none());

        approve_code(
            &store,
            &owner_approval,
            "req-1",
            approved(&["read"]),
            &Grant::parse([
                "wildflower/AuthorizationRequest.u",
                "wildflower/Grant.c",
                "wildflower/Client.c",
            ]),
            || "the-code".to_owned(),
        )
        .expect("the power to register the client approves");
        assert!(store.client_by_id("client").unwrap().is_some());
    }

    /// Widening a client's registration takes `wildflower/Client.u`: without
    /// it the approval is refused, naming it, and the row is untouched.
    #[test]
    fn approve_oauth_consent_requires_updating_a_widened_client() {
        let store = FakeGrantStore::default();
        let owner_approval = RecordingOwnerApproval::default();
        let registered = client("client", &["read"]);
        store.upsert_client(&registered).unwrap();
        let mut request = code_request(
            "req-1",
            RequestStatus::Pending,
            Utc::now() + Duration::minutes(5),
        );
        request.requested_scopes = vec!["read".to_owned(), "write".to_owned()];
        store.insert_authorization_request(&request).unwrap();

        let result = approve_code(
            &store,
            &owner_approval,
            "req-1",
            approved(&["read", "write"]),
            &approver_grant_with(&[]),
            || panic!("must not mint a code without the power to widen the client"),
        );
        assert_eq!(
            result,
            Err(AuthorizationServerError::InsufficientScope {
                missing_scopes: vec!["wildflower/Client.u".to_owned()],
            }),
        );
        assert_eq!(store.client_by_id("client").unwrap().unwrap(), registered);
    }

    /// The host app's registration is fixed, so approving its changed
    /// request widens nothing and takes no `wildflower/Client.u`.
    #[test]
    fn approving_for_a_fixed_registration_takes_no_client_scope() {
        let store = FakeGrantStore::default();
        seed_fixture_browser_session(&store);
        let owner_approval = RecordingOwnerApproval::default();
        store
            .upsert_client(&client(crate::WILDFLOWER_HOST_APP_CLIENT_ID, &["read"]))
            .unwrap();
        let mut request = code_request(
            "req-1",
            RequestStatus::Pending,
            Utc::now() + Duration::minutes(5),
        );
        request.client_id = crate::WILDFLOWER_HOST_APP_CLIENT_ID.to_owned();
        request.requested_scopes = vec!["read".to_owned(), "write".to_owned()];
        store.insert_authorization_request(&request).unwrap();

        let outcome = approve_code(
            &store,
            &owner_approval,
            "req-1",
            approved(&["read"]),
            &approver_grant_with(&[]),
            || "the-code".to_owned(),
        )
        .expect("no client scope is needed");
        assert!(matches!(outcome, ConsentOutcome::Approved { .. }));
    }

    /// Without `wildflower/Grant.c` an approval of a device request is
    /// refused, naming it, and writes nothing; a browser pairing, which
    /// records no grant, needs none.
    #[test]
    fn approve_device_consent_requires_creating_the_grant_but_a_pairing_does_not() {
        let store = FakeGrantStore::default();
        let owner_approval = RecordingOwnerApproval::default();
        store.upsert_client(&client("client", &["read"])).unwrap();
        store
            .insert_authorization_request(&device_request("dev-1", "UC-1", RequestStatus::Pending))
            .unwrap();
        let deciding_only =
            Grant::parse(["wildflower/AuthorizationRequest.u", "wildflower/launch"]);
        let result = approve_device_consent(
            &store,
            &owner_approval,
            "UC-1",
            ApproveDeviceConsentInput {
                owner_approved_scopes: vec!["read".to_owned()],
                patient: None,
                device_name: Some("My Phone".to_owned()),
            },
            &deciding_only,
            Utc::now(),
        );
        assert_eq!(
            result,
            Err(AuthorizationServerError::InsufficientScope {
                missing_scopes: vec!["wildflower/Grant.c".to_owned()],
            }),
        );
        assert!(store
            .device_grant_by_client_and_device_name("client", "My Phone")
            .unwrap()
            .is_none());
        assert_eq!(owner_approval.count(), 0);

        store
            .insert_authorization_request(&AuthorizationRequest {
                grant_type: GrantType::BrowserPairing,
                user_code: Some("UC-2".to_owned()),
                device_name: Some("Laptop".to_owned()),
                ..device_request("pair-1", "UC-2", RequestStatus::Pending)
            })
            .unwrap();
        let outcome = approve_device_consent(
            &store,
            &owner_approval,
            "UC-2",
            ApproveDeviceConsentInput {
                owner_approved_scopes: vec!["wildflower/launch".to_owned()],
                patient: None,
                device_name: None,
            },
            &deciding_only,
            Utc::now(),
        )
        .expect("a pairing takes no grant-creating scope");
        assert_eq!(outcome, ConsentOutcome::Approved { redirect: None });
    }

    /// The prompt a reader loads says which approval scopes it lacks for
    /// this request, and nothing for a reader holding them all.
    #[test]
    fn consent_reader_says_which_approval_scopes_the_reader_lacks() {
        let read_by = |reader_grant: Grant| {
            let store = FakeGrantStore::default();
            store
                .insert_authorization_request(&code_request(
                    "req-1",
                    RequestStatus::Pending,
                    Utc::now() + Duration::minutes(5),
                ))
                .unwrap();
            ConsentReader::new(
                store,
                reader_grant,
                crate::WILDFLOWER_HOST_APP_CLIENT_ID.into(),
            )
            .oauth_consent("req-1")
            .expect("view")
            .missing_approval_scopes
        };
        assert_eq!(
            read_by(Grant::parse(["wildflower/AuthorizationRequest.r"])),
            [
                "wildflower/AuthorizationRequest.u",
                "wildflower/Grant.c",
                "wildflower/Client.c",
            ],
        );
        assert_eq!(read_by(owner_grant()), Vec::<String>::new());
    }

    #[test]
    fn load_pending_code_request_accepts_a_live_request_and_refuses_the_rest() {
        let store = FakeGrantStore::default();
        store
            .insert_authorization_request(&code_request(
                "req-1",
                RequestStatus::Pending,
                Utc::now() + Duration::minutes(5),
            ))
            .unwrap();
        let loaded = load_pending_code_request(&store, "req-1").expect("live request");
        assert_eq!(loaded.request().id, "req-1");
        assert_eq!(loaded.redirect_uri().as_str(), "https://example.com/cb");
        assert_eq!(loaded.code_challenge().len(), 43);

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
                load_pending_code_request(&store, id),
                Err(AuthorizationServerError::OAuthConsentNotFound { id: id.to_owned() }),
            );
        }
    }

    #[test]
    fn consent_reader_oauth_consent_resolves_the_client_name() {
        let store = FakeGrantStore::default();
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
            owner_grant(),
            crate::WILDFLOWER_HOST_APP_CLIENT_ID.into(),
        );
        let view = reader.oauth_consent("req-1").expect("view");
        assert_eq!(view.request.id, "req-1");
        assert_eq!(
            view.requested_redirect_uri.as_str(),
            "https://example.com/cb"
        );
    }

    /// A client row the store cannot read fails the prompt read instead of
    /// rendering as an unknown (`New`) client, on both consent surfaces.
    #[test]
    fn consent_reader_surfaces_a_client_read_failure() {
        use crate::db::SqliteGrantStore;
        use diesel::RunQueryDsl;

        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        store.upsert_client(&client("client", &["read"])).unwrap();
        store
            .insert_authorization_request(&code_request(
                "req-1",
                RequestStatus::Pending,
                Utc::now() + Duration::minutes(5),
            ))
            .unwrap();
        store
            .insert_authorization_request(&device_request(
                "dev-1",
                "USER-CODE",
                RequestStatus::Pending,
            ))
            .unwrap();
        let mut conn = store.pool().get().expect("check out a connection");
        diesel::sql_query(
            "UPDATE clients SET allowed_scopes = 'not json' WHERE client_id = 'client'",
        )
        .execute(&mut conn)
        .expect("corrupt the stored row");
        drop(conn);

        let reader = ConsentReader::new(
            store,
            owner_grant(),
            crate::WILDFLOWER_HOST_APP_CLIENT_ID.into(),
        );
        assert!(matches!(
            reader.oauth_consent("req-1"),
            Err(AuthorizationServerError::Infrastructure { .. })
        ));
        assert!(matches!(
            reader.device_consent("USER-CODE"),
            Err(AuthorizationServerError::Infrastructure { .. })
        ));
    }
}
