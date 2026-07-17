//! Consent capabilities — the `wildflower/AuthorizationRequest.*` capabilities
//! behind `/access/oauth-consents/*` and `/access/devices/*`, and the consent
//! operations they own. The transaction scripts (load-and-validate, the
//! approve/deny flows, the standing-grant upserts they trigger) live here as
//! `&impl GatekeeperStore` functions so they stay unit-testable against the
//! in-memory fake; the capabilities are the scope-gated entries, generic over the
//! store and holding the port dependencies lifted from the state.

use std::collections::HashSet;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use scopes_rust::{grantable_scopes, Grant, Permission, Scope, WildflowerResource};
use uuid::Uuid;

use crate::domain::authorization_code::{
    AuthorizationCode, PendingCodeConsent, AUTHORIZATION_CODE_TTL,
};
use crate::domain::authorization_request::{AuthorizationRequest, GrantType, RequestStatus};
use crate::domain::client_redirect::build_client_redirect_url;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::grant::{AuthorizationCodeGrant, CumulativeConsent, DeviceGrant};
use crate::domain::{GatekeeperStore, GatekeeperTx};
use crate::ports::DeviceUserCodePublisher;

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
/// authorization-code consent handler needs, with the client's display name
/// already resolved.
pub(crate) struct OAuthConsentView {
    pub(crate) request: AuthorizationRequest,
    pub(crate) redirect_uri: url::Url,
    pub(crate) client_name: String,
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
// Loaders — validate a pending request and unwrap it (parse-don't-validate).
// ---------------------------------------------------------------------------

/// Load the authorization request for `id` and verify it's a pending, unexpired
/// authorization-code flow carrying both a `redirect_uri` and a PKCE
/// `code_challenge`. On success the two optional fields are unwrapped into the
/// returned [`PendingCodeConsent`]. A request whose `expires_at` has passed is
/// treated as not found — the deadline is enforced here at read time.
fn load_pending_authorization_code_request(
    store: &impl GatekeeperStore,
    id: &str,
) -> Result<PendingCodeConsent, GatekeeperError> {
    let make_consent_not_found = || GatekeeperError::OAuthConsentNotFound { id: id.to_owned() };
    match store.authorization_request_by_id(id)? {
        Some(r)
            if r.status == RequestStatus::Pending
                && r.grant_type == GrantType::AuthorizationCode
                && r.expires_at > Utc::now() =>
        {
            match (r.redirect_uri.clone(), r.code_challenge.clone()) {
                (Some(redirect_uri), Some(code_challenge)) => Ok(PendingCodeConsent {
                    request: r,
                    redirect_uri,
                    code_challenge,
                }),
                _ => Err(make_consent_not_found()),
            }
        }
        _ => Err(make_consent_not_found()),
    }
}

/// Load the authorization request for `user_code` and verify it's a pending,
/// unexpired device-code flow.
fn load_pending_device_request(
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

// ---------------------------------------------------------------------------
// Standing-grant upserts — the read-merge-write transaction scripts consent
// approval triggers. Their only runtime caller is the approve flow below.
// ---------------------------------------------------------------------------

/// Insert or cumulatively update the standing authorization-code grant for
/// `(client_id, redirect_uri)`, all inside one `BEGIN IMMEDIATE` transaction:
/// read the standing grant; if present, fold the re-approval in via
/// [`CumulativeConsent::absorb_reapproval`] and write it back; otherwise mint a
/// fresh grant. `BEGIN IMMEDIATE` takes the write lock before the read, so two
/// concurrent approvals serialise at the read rather than both reading the
/// pre-merge row and one losing its scope union.
fn upsert_authorization_code_grant(
    store: &impl GatekeeperStore,
    client_id: &str,
    redirect_uri: &url::Url,
    scopes: &[String],
    patient: Option<&str>,
    now: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    store.immediate_transaction(|tx| {
        match tx.grant_by_client_and_redirect(client_id, redirect_uri)? {
            Some(mut grant) => {
                grant.absorb_reapproval(scopes, patient, now);
                tx.update_authorization_code_grant(&grant)
            }
            None => tx.create_authorization_code_grant(&AuthorizationCodeGrant {
                id: Uuid::new_v4().to_string(),
                client_id: client_id.to_owned(),
                scopes: scopes.to_vec(),
                granted_at: now,
                last_used_at: None,
                patient: patient.map(str::to_owned),
                redirect_uri: redirect_uri.clone(),
            }),
        }
    })
}

/// Insert or cumulatively update the standing device grant for
/// `(client_id, device_name)`, same read-merge-write-under-`BEGIN IMMEDIATE`
/// shape as [`upsert_authorization_code_grant`], keyed on the device name.
fn upsert_device_grant(
    store: &impl GatekeeperStore,
    client_id: &str,
    device_name: &str,
    scopes: &[String],
    patient: Option<&str>,
    now: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    store.immediate_transaction(|tx| {
        match tx.device_grant_by_client_and_device_name(client_id, device_name)? {
            Some(mut grant) => {
                grant.absorb_reapproval(scopes, patient, now);
                tx.update_device_grant(&grant)
            }
            None => tx.create_device_grant(&DeviceGrant {
                id: Uuid::new_v4().to_string(),
                client_id: client_id.to_owned(),
                scopes: scopes.to_vec(),
                granted_at: now,
                last_used_at: None,
                patient: patient.map(str::to_owned),
                device_name: device_name.to_owned(),
            }),
        }
    })
}

// ---------------------------------------------------------------------------
// The approve/deny transaction scripts.
// ---------------------------------------------------------------------------

/// Approve an authorization-code consent prompt: narrow the approved scopes to
/// the requested-and-allowed set, transition the request, mint and persist the
/// authorization code the polling endpoint hands back, refresh the standing
/// grant, and return the client callback URL. An approval that grants nothing is
/// applied as a **deny**. `approver` is the deciding Owner's granted scopes — the
/// approval can't delegate a resource scope the approver doesn't hold (see
/// [`ensure_approver_covers`]).
fn approve_oauth_consent(
    store: &impl GatekeeperStore,
    publisher: &dyn DeviceUserCodePublisher,
    id: &str,
    input: ApproveOAuthConsentInput,
    approver: &Grant,
    generate_code: impl FnOnce() -> String,
    now: DateTime<Utc>,
) -> Result<ConsentOutcome, GatekeeperError> {
    let make_consent_not_found = || GatekeeperError::OAuthConsentNotFound { id: id.to_owned() };
    let PendingCodeConsent {
        request,
        redirect_uri,
        code_challenge,
    } = load_pending_authorization_code_request(store, id)?;

    let requested: HashSet<&str> = request
        .requested_scopes
        .iter()
        .map(String::as_str)
        .collect();
    let client = store
        .client_by_id(&request.client_id)?
        .ok_or_else(make_consent_not_found)?;
    let allowed: HashSet<&str> = client.allowed_scopes.iter().map(String::as_str).collect();
    let granted_scopes = grantable_scopes(input.approved_scopes, &requested, &allowed);
    if granted_scopes.is_empty() {
        return deny_consent(store, publisher, id).map(|()| ConsentOutcome::Denied);
    }
    ensure_approver_covers(&granted_scopes, approver)?;

    let approved =
        store.approve_authorization_request(id, &granted_scopes, input.patient.as_deref(), None)?;
    if !approved {
        return Err(make_consent_not_found());
    }

    let authorization_code = AuthorizationCode {
        code: generate_code(),
        request_id: id.to_owned(),
        client_id: request.client_id.clone(),
        redirect_uri: redirect_uri.clone(),
        code_challenge,
        granted_scopes: granted_scopes.clone(),
        patient: input.patient.clone(),
        issued_at: now,
        expires_at: now + AUTHORIZATION_CODE_TTL,
    };
    store.issue_authorization_code(&authorization_code)?;

    upsert_authorization_code_grant(
        store,
        &request.client_id,
        &redirect_uri,
        &granted_scopes,
        input.patient.as_deref(),
        now,
    )?;

    let redirect = request.client_state.as_deref().map(|client_state| {
        build_client_redirect_url(&redirect_uri, &authorization_code.code, client_state)
    });
    Ok(ConsentOutcome::Approved { redirect })
}

/// Approve a device-code consent prompt: apply the **expandable** scope decision
/// (up to the client's `allowed_scopes`), transition the request, mint (or
/// refresh) the standing device grant, and republish the popup head. An approval
/// that grants nothing is applied as a **deny**.
fn approve_device_consent(
    store: &impl GatekeeperStore,
    publisher: &dyn DeviceUserCodePublisher,
    user_code: &str,
    input: ApproveDeviceConsentInput,
    approver: &Grant,
    now: DateTime<Utc>,
) -> Result<ConsentOutcome, GatekeeperError> {
    let make_consent_not_found = || GatekeeperError::DeviceConsentNotFound {
        user_code: user_code.to_owned(),
    };
    let device_request = load_pending_device_request(store, user_code)?;
    let client = store
        .client_by_id(&device_request.client_id)?
        .ok_or_else(make_consent_not_found)?;

    let allowed: HashSet<&str> = client.allowed_scopes.iter().map(String::as_str).collect();
    let granted_scopes = grantable_scopes(input.approved_scopes, &allowed, &allowed);
    if granted_scopes.is_empty() {
        return deny_consent(store, publisher, &device_request.id).map(|()| ConsentOutcome::Denied);
    }
    ensure_approver_covers(&granted_scopes, approver)?;

    let request_device_name = input
        .device_name
        .as_deref()
        .or(device_request.device_name.as_deref());
    let approved = store.approve_authorization_request(
        &device_request.id,
        &granted_scopes,
        input.patient.as_deref(),
        request_device_name,
    )?;
    if !approved {
        return Err(make_consent_not_found());
    }

    let effective_device_name = request_device_name.unwrap_or(client.name.as_str());
    upsert_device_grant(
        store,
        &device_request.client_id,
        effective_device_name,
        &granted_scopes,
        input.patient.as_deref(),
        now,
    )?;

    publisher.republish_active();
    Ok(ConsentOutcome::Approved { redirect: None })
}

/// Deny the pending authorization-code request `id`. Validates it's a live
/// code-flow prompt first (so a stale/unknown id is the structured 404), then
/// marks it denied and republishes the popup head.
fn deny_oauth_consent(
    store: &impl GatekeeperStore,
    publisher: &dyn DeviceUserCodePublisher,
    id: &str,
) -> Result<(), GatekeeperError> {
    load_pending_authorization_code_request(store, id)?;
    deny_consent(store, publisher, id)
}

/// Deny the pending device-code request behind `user_code`. Validates it's a live
/// device-flow prompt first, then marks it denied and republishes the popup head.
fn deny_device_consent(
    store: &impl GatekeeperStore,
    publisher: &dyn DeviceUserCodePublisher,
    user_code: &str,
) -> Result<(), GatekeeperError> {
    let device_request = load_pending_device_request(store, user_code)?;
    deny_consent(store, publisher, &device_request.id)
}

/// Mark request `request_id` denied and republish the active device-consent head
/// — the shared tail of every deny path (explicit deny + a nothing-granted
/// approve). Code-flow denies are no-ops against the device-only query, so this
/// is called unconditionally.
fn deny_consent(
    store: &impl GatekeeperStore,
    publisher: &dyn DeviceUserCodePublisher,
    request_id: &str,
) -> Result<(), GatekeeperError> {
    store.deny_authorization_request(request_id)?;
    publisher.republish_active();
    Ok(())
}

/// Reject (with a `403`-rendering error, NOT a silent narrowing) any **resource**
/// scope in `granted_scopes` the `approver`'s own grant doesn't authorize — "an
/// approver can't delegate more permission than they hold". Only FHIR/Wildflower
/// resource scopes are checked; identity/session markers (`openid`,
/// `offline_access`, …) pass through. Authority is checked across both the SMART
/// v1-word and v2-letter spellings via [`Scope::as_alternate_canonical_form`],
/// the same twinning the token minter applies, which bridges the spelling without
/// widening the underlying interactions.
fn ensure_approver_covers(
    granted_scopes: &[String],
    approver: &Grant,
) -> Result<(), GatekeeperError> {
    let approver_authority = Grant::new(
        approver
            .scopes
            .iter()
            .flat_map(|held| [Some(held.clone()), held.as_alternate_canonical_form()])
            .flatten()
            .collect(),
    );
    let authorizes = |scope: &Scope| {
        approver_authority.covers(scope)
            || scope
                .as_alternate_canonical_form()
                .is_some_and(|twin| approver_authority.covers(&twin))
    };
    let missing_scopes: Vec<String> = granted_scopes
        .iter()
        .filter(|rendered| {
            let scope = Scope::from(rendered.as_str());
            matches!(scope, Scope::FhirResource(_) | Scope::WildflowerResource(_))
                && !authorizes(&scope)
        })
        .cloned()
        .collect();
    if missing_scopes.is_empty() {
        Ok(())
    } else {
        Err(GatekeeperError::InsufficientApproverScope { missing_scopes })
    }
}

// ---------------------------------------------------------------------------
// The capabilities.
// ---------------------------------------------------------------------------

/// Read access to pending consent prompts — the `GET` sides of
/// `/access/oauth-consents/{id}` and `/access/devices/{userCode}`.
pub(crate) struct ConsentReader<S: GatekeeperStore> {
    store: S,
}

impl<S: GatekeeperStore> ConsentReader<S> {
    /// Build the reader over a store handle lifted from the state.
    pub(crate) fn new(store: S) -> Self {
        ConsentReader { store }
    }

    /// The client's registered display name, or its raw `client_id` when the
    /// lookup misses or fails — the shared fallback both consent views use.
    fn client_display_name(&self, client_id: &str) -> String {
        match self.store.client_by_id(client_id) {
            Ok(Some(client)) => client.name,
            _ => client_id.to_owned(),
        }
    }

    /// Load a pending authorization-code consent prompt for the Owner UI.
    pub(crate) fn oauth_consent(&self, id: &str) -> Result<OAuthConsentView, GatekeeperError> {
        let PendingCodeConsent {
            request,
            redirect_uri,
            ..
        } = load_pending_authorization_code_request(&self.store, id)?;
        let client_name = self.client_display_name(&request.client_id);
        Ok(OAuthConsentView {
            request,
            redirect_uri,
            client_name,
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
}

impl<S: GatekeeperStore> ConsentDecider<S> {
    /// Build the decider over a store handle, the republish port, and the
    /// approver's own granted scopes — all lifted from the state + claims.
    pub(crate) fn new(
        store: S,
        publisher: Arc<dyn DeviceUserCodePublisher>,
        approver: Grant,
    ) -> Self {
        ConsentDecider {
            store,
            publisher,
            approver,
        }
    }

    /// Approve an authorization-code consent; a resource scope beyond the
    /// approver's own authority fails the approval with a `403`.
    pub(crate) fn approve_oauth(
        &self,
        id: &str,
        input: ApproveOAuthConsentInput,
        generate_code: impl FnOnce() -> String,
        now: DateTime<Utc>,
    ) -> Result<ConsentOutcome, GatekeeperError> {
        approve_oauth_consent(
            &self.store,
            self.publisher.as_ref(),
            id,
            input,
            &self.approver,
            generate_code,
            now,
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

    use super::*;
    use crate::domain::test_fake::{client, code_request, device_request, FakeGatekeeperStore};

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
        let outcome = approve_oauth_consent(
            &store,
            &publisher,
            "req-1",
            ApproveOAuthConsentInput {
                approved_scopes: vec!["read".to_owned()],
                patient: None,
            },
            &owner_grant(),
            || "the-code".to_owned(),
            Utc::now(),
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
        let outcome = approve_oauth_consent(
            &store,
            &publisher,
            "req-1",
            ApproveOAuthConsentInput {
                approved_scopes: vec!["write".to_owned()],
                patient: None,
            },
            &owner_grant(),
            || panic!("must not mint a code on a deny"),
            Utc::now(),
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

    #[test]
    fn approve_oauth_consent_maps_a_missing_request_to_not_found() {
        let store = FakeGatekeeperStore::default();
        let publisher = RecordingPublisher::default();
        assert_eq!(
            approve_oauth_consent(
                &store,
                &publisher,
                "ghost",
                ApproveOAuthConsentInput {
                    approved_scopes: vec!["read".to_owned()],
                    patient: None,
                },
                &owner_grant(),
                || "unused".to_owned(),
                Utc::now(),
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
        let result = approve_oauth_consent(
            &store,
            &publisher,
            "req-1",
            ApproveOAuthConsentInput {
                approved_scopes: vec!["system/Patient.r".to_owned()],
                patient: None,
            },
            &approver,
            || panic!("must not mint a code when the approver lacks authority"),
            Utc::now(),
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
        let reader = ConsentReader::new(store);
        let view = reader.oauth_consent("req-1").expect("view");
        assert_eq!(view.request.id, "req-1");
        assert_eq!(view.redirect_uri.as_str(), "https://example.com/cb");
    }
}
