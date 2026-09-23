//! Authorization-code consent: load/approve/deny the code-flow prompt. An
//! approval obtains a [`DelegatedScopes`] proof and hands it to the writers —
//! the [`RequestApprover`] issues the code, the [`GrantRecorder`] records the
//! standing grant and (for a client trusted on first use) the registration.

use chrono::{DateTime, Utc};

use super::delegation::deny_consent;
use super::{ApproveOAuthConsentInput, ConsentOutcome};
use crate::domain::authority::{ApprovableScopes, DelegatedScopes};
use crate::domain::authorization_code::PendingCodeRequest;
use crate::domain::authorization_request::{GrantType, RequestStatus};
use crate::domain::capabilities::writers::{CodeAuthority, GrantRecorder, RequestApprover};
use crate::domain::client_redirect::build_client_redirect_url;
use crate::domain::client_registration::RegistrationClassifier;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::GatekeeperStore;
use crate::ports::PendingConsentPublisher;
use scopes_rust::Grant;

/// Everything an approval needs beyond the prompt itself: who is approving, how
/// to judge the client's registration, which client's registration is locked,
/// and the instant the writes are stamped with. Bundled (rather than five more
/// parameters) so [`approve_oauth_consent`]'s signature stays readable.
pub(super) struct ApprovalContext<'a> {
    /// The deciding Owner's own granted scopes — the bound on what the
    /// approval may delegate (see [`DelegatedScopes::clamp`]).
    pub(super) approver: &'a Grant,
    /// Judges the request against the client's current registration.
    pub(super) classifier: &'a RegistrationClassifier<'a>,
    /// The first-party host's `client_id` — the one client whose registration
    /// is locked: never trusted on first use, never widened by an approval.
    pub(super) first_party_client_id: &'a str,
    /// The instant stamped onto the code and the standing grant.
    pub(super) now: DateTime<Utc>,
}

/// Load the authorization request for `id` and verify it's a pending, unexpired
/// authorization-code flow carrying both a `redirect_uri` and a PKCE
/// `code_challenge`. On success the two optional fields are unwrapped into the
/// returned [`PendingCodeRequest`]. A request whose `expires_at` has passed is
/// treated as not found — the deadline is enforced here at read time.
pub(super) fn load_pending_code_request(
    store: &impl GatekeeperStore,
    id: &str,
) -> Result<PendingCodeRequest, GatekeeperError> {
    let make_consent_not_found = || GatekeeperError::OAuthConsentNotFound { id: id.to_owned() };
    match store.authorization_request_by_id(id)? {
        Some(r)
            if r.status == RequestStatus::Pending
                && r.grant_type == GrantType::AuthorizationCode
                && r.expires_at > Utc::now() =>
        {
            PendingCodeRequest::from_request(r).ok_or_else(make_consent_not_found)
        }
        _ => Err(make_consent_not_found()),
    }
}

/// Approve an authorization-code consent prompt: clamp the Owner's ticks into a
/// [`DelegatedScopes`] proof, issue the code, record the standing grant (and,
/// for a client trusted on first use, its registration), republish the popup
/// head, and return the client callback URL. An approval that grants nothing is
/// applied as a **deny**.
///
/// A request the
/// [registration verdict](crate::domain::client_registration::ClientRegistration)
/// finds new or changed must carry the Owner's
/// [`acknowledged_registration`](ApproveOAuthConsentInput::acknowledged_registration),
/// else it fails with
/// [`RegistrationNotAcknowledged`](GatekeeperError::RegistrationNotAcknowledged)
/// and nothing is written.
pub(super) fn approve_oauth_consent(
    store: &impl GatekeeperStore,
    publisher: &dyn PendingConsentPublisher,
    id: &str,
    input: ApproveOAuthConsentInput,
    generate_code: impl FnOnce() -> String,
    ctx: &ApprovalContext<'_>,
) -> Result<ConsentOutcome, GatekeeperError> {
    let now = ctx.now;
    let make_consent_not_found = || GatekeeperError::OAuthConsentNotFound { id: id.to_owned() };
    let pending_request = load_pending_code_request(store, id)?;
    let request = pending_request.request();
    let requested_redirect_uri = pending_request.redirect_uri();

    // The first-party host is held to its registration; every other client is
    // trusted on first use, so its registration may be created or widened.
    let registration_is_locked = request.client_id == ctx.first_party_client_id;
    let maybe_existing_client = store.client_by_id(&request.client_id)?;
    if registration_is_locked && maybe_existing_client.is_none() {
        return Err(make_consent_not_found());
    }
    let registration = ctx.classifier.classify(
        &request.client_id,
        maybe_existing_client.as_ref(),
        requested_redirect_uri,
        &request.requested_scopes,
    );
    if registration.needs_acknowledgement() && !input.acknowledged_registration {
        return Err(GatekeeperError::RegistrationNotAcknowledged { id: id.to_owned() });
    }

    // The proof every write below demands: the Owner's approval clamped to
    // what this prompt may grant and covered by the approver's own grant.
    let Some(delegated_scopes) = DelegatedScopes::clamp(
        ctx.approver,
        input.approved_scopes,
        &ApprovableScopes::for_code(
            &request.requested_scopes,
            maybe_existing_client.as_ref(),
            registration_is_locked,
        ),
    )?
    else {
        return deny_consent(store, publisher, id).map(|()| ConsentOutcome::Denied);
    };

    let Some(issued_code) = RequestApprover::over(store).approve_for_code(
        CodeAuthority::OwnerDelegated(&delegated_scopes),
        &pending_request,
        input.patient.as_deref(),
        generate_code(),
        now,
    )?
    else {
        return Err(make_consent_not_found());
    };

    // Persist the (possibly brand-new) registration with the grant it justifies:
    // one transaction, so a client row never outlives a failed approval.
    let registration_to_widen = (!registration_is_locked).then_some(&registration);
    GrantRecorder::over(store).record_code_grant(
        &request.client_id,
        requested_redirect_uri,
        &delegated_scopes,
        input.patient.as_deref(),
        now,
        registration_to_widen,
    )?;

    // This request was the popup head (or queued behind one) until the approval
    // above flipped it out of `pending`, so the head has to be recomputed — the
    // popup must close, or advance to whatever was queued behind it.
    publisher.republish_active();

    let redirect = request.client_state.as_deref().map(|client_state| {
        build_client_redirect_url(requested_redirect_uri, &issued_code.code, client_state)
    });
    Ok(ConsentOutcome::Approved { redirect })
}

/// Deny the pending authorization-code request `id`. Validates it's a live
/// code-flow prompt first (so a stale/unknown id is the structured 404), then
/// marks it denied and republishes the popup head.
pub(super) fn deny_oauth_consent(
    store: &impl GatekeeperStore,
    publisher: &dyn PendingConsentPublisher,
    id: &str,
) -> Result<(), GatekeeperError> {
    load_pending_code_request(store, id)?;
    deny_consent(store, publisher, id)
}
