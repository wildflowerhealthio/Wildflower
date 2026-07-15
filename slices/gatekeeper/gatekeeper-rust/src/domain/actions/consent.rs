//! Owner **consent** actions — the coarse, testable domain operations behind the
//! two consent surfaces' approve/deny handlers (`/oauth-consents/{id}` and
//! `/devices/{userCode}`). Each owns the whole transaction script — load and
//! validate the pending request, narrow (or expand) the scope decision,
//! transition the request, and for the code flow mint the authorization code and
//! build the client callback URL it returns — so the HTTP handlers shrink to
//! "parse the body, call the action, render its outcome". The one runtime
//! side-effect a device transition needs (republishing the popup head over the
//! bridge) is reached through the [`DeviceUserCodePublisher`] port, and code
//! minting through an injected generator, so the actions stay pure over the store
//! and unit-testable against [`FakeGatekeeperStore`](super::test_fake).

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use scopes_rust::grantable_scopes;

use super::{
    approve_authorization_request, client_by_id, deny_authorization_request,
    issue_authorization_code, load_pending_authorization_code_request, load_pending_device_request,
    upsert_authorization_code_grant, upsert_device_grant,
};
use crate::domain::authorization_code::{AuthorizationCode, AUTHORIZATION_CODE_TTL};
use crate::domain::client_redirect::build_client_redirect_url;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::GatekeeperStore;
use crate::domain::PendingCodeConsent;
use crate::ports::DeviceUserCodePublisher;

/// The Owner's decision on a consent prompt, after the action has applied it —
/// what the handler renders as a `ConsentResult`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ConsentOutcome {
    /// Approved. `redirect` is the client callback URL to hand back so an
    /// approving surface that *is* the requesting client can finish inline
    /// (code flow with a `client_state`); `None` for the device flow (no client
    /// `redirect_uri`) or a state-less code request.
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

/// Approve an authorization-code consent prompt: narrow the approved scopes to
/// the requested-and-allowed set, transition the request, mint and persist the
/// authorization code the polling endpoint hands back, refresh the standing
/// grant, and return the client callback URL. An approval that grants nothing
/// (no requested-and-allowed scope ticked) is applied as a **deny** instead.
///
/// `generate_code` mints the opaque authorization code (injected so the action
/// stays crypto-free and deterministic in tests); `now` stamps issuance.
///
/// # Errors
///
/// [`GatekeeperError::OAuthConsentNotFound`] when no pending, unexpired,
/// well-formed code-flow request has this id (or its client is gone, or it was
/// concurrently consumed); [`GatekeeperError::Infrastructure`] on a store failure.
pub(crate) fn approve_oauth_consent(
    store: &impl GatekeeperStore,
    publisher: &impl DeviceUserCodePublisher,
    id: &str,
    input: ApproveOAuthConsentInput,
    generate_code: impl FnOnce() -> String,
    now: DateTime<Utc>,
) -> Result<ConsentOutcome, GatekeeperError> {
    let make_consent_not_found = || GatekeeperError::OAuthConsentNotFound { id: id.to_owned() };
    let PendingCodeConsent {
        request,
        redirect_uri,
        code_challenge,
    } = load_pending_authorization_code_request(store, id)?;

    // The Owner can only narrow, never widen: intersect what they approved with
    // what the client requested, then clamp to the client's current
    // `allowed_scopes` so a stale request can't grant beyond the client's policy.
    let requested: HashSet<&str> = request
        .requested_scopes
        .iter()
        .map(String::as_str)
        .collect();
    // The request can't be approved against a client that no longer exists —
    // treat it as gone.
    let client = client_by_id(store, &request.client_id)?.ok_or_else(make_consent_not_found)?;
    let allowed: HashSet<&str> = client.allowed_scopes.iter().map(String::as_str).collect();
    let granted_scopes = grantable_scopes(input.approved_scopes, &requested, &allowed);
    if granted_scopes.is_empty() {
        // No requested-and-allowed scopes were approved — apply as a deny.
        return deny_consent(store, publisher, id).map(|()| ConsentOutcome::Denied);
    }

    let approved =
        approve_authorization_request(store, id, &granted_scopes, input.patient.as_deref(), None)?;
    if !approved {
        // No longer pending (concurrently consumed/denied/expired) — treat the
        // consent as gone rather than minting a code against a stale request.
        return Err(make_consent_not_found());
    }

    // Mint and persist the authorization code so the polling endpoint's
    // `Approved` arm can hand the client back a redeemable `code`. The PKCE
    // `code_challenge` was already unwrapped by the loader.
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
    issue_authorization_code(store, &authorization_code)?;

    // Refresh the standing grant (scope union with any prior grant), keyed on
    // (client_id, redirect_uri) so a re-approval accumulates rather than dupes.
    upsert_authorization_code_grant(
        store,
        &request.client_id,
        &redirect_uri,
        &granted_scopes,
        input.patient.as_deref(),
        now,
    )?;

    // Hand back the client callback URL so an approving surface that *is* the
    // requesting client can finish the flow inline. `client_state` is `Option`
    // only structurally — `/oauth/authorize` requires `state`, so a stored
    // code-flow request always carries it and the `None` branch is unreachable.
    let redirect = request.client_state.as_deref().map(|client_state| {
        build_client_redirect_url(&redirect_uri, &authorization_code.code, client_state)
    });
    Ok(ConsentOutcome::Approved { redirect })
}

/// Approve a device-code consent prompt: apply the **expandable** scope decision
/// (the Owner pairing a device may grant up to the client's full
/// `allowed_scopes`, unlike the code flow), transition the request, mint (or
/// refresh) the standing device grant keyed on the effective device name, and
/// republish the popup head. An approval that grants nothing is applied as a
/// **deny**. Device approvals have no client `redirect_uri`, so the outcome
/// never carries one.
///
/// # Errors
///
/// [`GatekeeperError::DeviceConsentNotFound`] when no pending, unexpired
/// device-flow request has this user code (or its client is gone, or it was
/// concurrently consumed); [`GatekeeperError::Infrastructure`] on a store failure.
pub(crate) fn approve_device_consent(
    store: &impl GatekeeperStore,
    publisher: &impl DeviceUserCodePublisher,
    user_code: &str,
    input: ApproveDeviceConsentInput,
    now: DateTime<Utc>,
) -> Result<ConsentOutcome, GatekeeperError> {
    let make_consent_not_found = || GatekeeperError::DeviceConsentNotFound {
        user_code: user_code.to_owned(),
    };
    let device_request = load_pending_device_request(store, user_code)?;
    let client =
        client_by_id(store, &device_request.client_id)?.ok_or_else(make_consent_not_found)?;

    // Device-code consent is EXPANDABLE: the approver may grant scopes beyond
    // what the device requested, up to the client's `allowed_scopes` — so the
    // requested envelope is widened to `allowed` (passed as both bounds).
    // Coverage-aware `grantable_scopes` still refuses anything the client isn't
    // allowed. (The code flow stays clamped to `requested_scopes`.)
    let allowed: HashSet<&str> = client.allowed_scopes.iter().map(String::as_str).collect();
    let granted_scopes = grantable_scopes(input.approved_scopes, &allowed, &allowed);
    if granted_scopes.is_empty() {
        // No allowed scopes were approved — apply as a deny.
        return deny_consent(store, publisher, &device_request.id).map(|()| ConsentOutcome::Denied);
    }

    // Resolve the name written onto the *request*: the approver's adjustment,
    // else the device's own name (the store writes this verbatim — it no longer
    // COALESCEs a `None` back onto the stored value).
    let request_device_name = input
        .device_name
        .as_deref()
        .or(device_request.device_name.as_deref());
    let approved = approve_authorization_request(
        store,
        &device_request.id,
        &granted_scopes,
        input.patient.as_deref(),
        request_device_name,
    )?;
    if !approved {
        return Err(make_consent_not_found());
    }

    // Mint (or refresh) the durable device grant, keyed on the *effective*
    // device name: the resolved request name, else the client's name (RFC 8628
    // requesters may not name themselves — a total key keeps the
    // (client_id, device_name) upsert well-defined).
    let effective_device_name = request_device_name.unwrap_or(client.name.as_str());
    upsert_device_grant(
        store,
        &device_request.client_id,
        effective_device_name,
        &granted_scopes,
        input.patient.as_deref(),
        now,
    )?;

    // The popup's head may have just resolved; recompute and republish so the
    // modal closes (no more pending) or jumps to the next queued request.
    publisher.republish_active();
    Ok(ConsentOutcome::Approved { redirect: None })
}

/// Deny the pending authorization-code request `id` — the `/oauth-consents/{id}/deny`
/// action. Validates the request is a live code-flow prompt first (so a stale or
/// unknown id is the structured 404), then marks it denied and republishes the
/// popup head (a no-op against the device-only query, safe to call for both flows).
///
/// # Errors
///
/// [`GatekeeperError::OAuthConsentNotFound`] when no pending, unexpired,
/// well-formed code-flow request has this id; [`GatekeeperError::Infrastructure`]
/// on a store failure.
pub(crate) fn deny_oauth_consent(
    store: &impl GatekeeperStore,
    publisher: &impl DeviceUserCodePublisher,
    id: &str,
) -> Result<(), GatekeeperError> {
    load_pending_authorization_code_request(store, id)?;
    deny_consent(store, publisher, id)
}

/// Deny the pending device-code request behind `user_code` — the
/// `/devices/{userCode}/deny` action. Validates the request is a live device-flow
/// prompt first (so a stale or unknown user code is the structured 404), then
/// marks it denied and republishes the popup head.
///
/// # Errors
///
/// [`GatekeeperError::DeviceConsentNotFound`] when no pending, unexpired
/// device-flow request has this user code; [`GatekeeperError::Infrastructure`]
/// on a store failure.
pub(crate) fn deny_device_consent(
    store: &impl GatekeeperStore,
    publisher: &impl DeviceUserCodePublisher,
    user_code: &str,
) -> Result<(), GatekeeperError> {
    let device_request = load_pending_device_request(store, user_code)?;
    deny_consent(store, publisher, &device_request.id)
}

/// Mark request `request_id` denied and republish the active device-consent head.
/// The shared tail of every deny path (explicit deny + a nothing-granted approve):
/// a device-flow deny may have resolved the popup's head, so the modal needs to
/// close or advance; code-flow denies are no-ops against the device-only query,
/// so this is called unconditionally rather than threading a `grant_type`.
fn deny_consent(
    store: &impl GatekeeperStore,
    publisher: &impl DeviceUserCodePublisher,
    request_id: &str,
) -> Result<(), GatekeeperError> {
    deny_authorization_request(store, request_id)?;
    publisher.republish_active();
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use chrono::Duration;

    use super::super::test_fake::{client, code_request, device_request, FakeGatekeeperStore};
    use super::*;
    use crate::domain::authorization_request::RequestStatus;

    /// A [`DeviceUserCodePublisher`] that just counts republish calls.
    #[derive(Default)]
    struct RecordingPublisher {
        republishes: Cell<u32>,
    }

    impl DeviceUserCodePublisher for RecordingPublisher {
        fn republish_active(&self) {
            self.republishes.set(self.republishes.get() + 1);
        }
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
        // The code was persisted against the request, and a standing grant exists.
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
        // A code approval doesn't touch the device popup.
        assert_eq!(publisher.republishes.get(), 0);
    }

    #[test]
    fn approve_oauth_consent_with_nothing_granted_is_a_deny() {
        let (store, publisher) = live_code_store();
        let outcome = approve_oauth_consent(
            &store,
            &publisher,
            "req-1",
            ApproveOAuthConsentInput {
                // Requested "read"; approving only an un-requested scope grants nothing.
                approved_scopes: vec!["write".to_owned()],
                patient: None,
            },
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
        // A deny republishes (harmless no-op for the code flow's request).
        assert_eq!(publisher.republishes.get(), 1);
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
        // The device requested only "openid"; the approver may grant "read" too.
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
            Utc::now(),
        )
        .unwrap();
        assert_eq!(outcome, ConsentOutcome::Approved { redirect: None });
        // The grant landed under the approver-chosen effective device name, with
        // the expanded scope.
        let grant = store
            .device_grant_by_client_and_device_name("client", "My Phone")
            .unwrap()
            .expect("device grant");
        assert_eq!(grant.scopes, vec!["read".to_owned()]);
        assert_eq!(publisher.republishes.get(), 1);
    }

    #[test]
    fn approve_device_consent_with_nothing_granted_is_a_deny() {
        let store = FakeGatekeeperStore::default();
        let publisher = RecordingPublisher::default();
        store.upsert_client(&client("client", &["openid"])).unwrap();
        store
            .insert_authorization_request(&device_request("dev-1", "UC-1", RequestStatus::Pending))
            .unwrap();
        let outcome = approve_device_consent(
            &store,
            &publisher,
            "UC-1",
            ApproveDeviceConsentInput {
                // "write" isn't in the client's allowed set → nothing granted.
                approved_scopes: vec!["write".to_owned()],
                patient: None,
                device_name: None,
            },
            Utc::now(),
        )
        .unwrap();
        assert_eq!(outcome, ConsentOutcome::Denied);
        assert_eq!(
            store
                .authorization_request_by_id("dev-1")
                .unwrap()
                .unwrap()
                .status,
            RequestStatus::Denied,
        );
        assert_eq!(publisher.republishes.get(), 1);
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
        assert_eq!(publisher.republishes.get(), 1);
        // An unknown user code is the structured 404.
        assert_eq!(
            deny_device_consent(&store, &publisher, "UNKNOWN"),
            Err(GatekeeperError::DeviceConsentNotFound {
                user_code: "UNKNOWN".to_owned()
            }),
        );
    }
}
