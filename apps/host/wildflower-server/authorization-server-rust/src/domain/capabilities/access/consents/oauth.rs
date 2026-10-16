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
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::writers::{
    CodeApproval, CodeAuthority, GrantRecorder, RequestApprover,
};
use crate::domain::client_redirect::{build_client_error_redirect_url, build_client_redirect_url};
use crate::domain::client_registration::{classify_registration, PresentedClientRegistration};
use crate::domain::oauth_error_code::OAuthErrorCode;
use crate::domain::GrantStore;
use crate::ports::OwnerApproval;
use wildflowerhealthio_scopes::Grant;

/// Everything an approval needs beyond the prompt itself: who is approving,
/// which client's registration is fixed, and the instant the writes are
/// stamped with. Bundled (rather than three more parameters) so
/// [`approve_oauth_consent`]'s signature stays readable.
pub(crate) struct ApprovalContext<'a> {
    /// The deciding Owner's own granted scopes — the bound on what the
    /// approval may delegate (see [`DelegatedScopes::clamp`]).
    pub(crate) approver_grant: &'a Grant,
    /// The host app's `client_id` — the one client whose registration is
    /// fixed: defined by the server, never trusted on first use, never
    /// widened by an approval.
    pub(crate) wildflower_host_app_client_id: &'a str,
    /// The instant stamped onto the code and the standing grant.
    pub(crate) now: DateTime<Utc>,
}

/// Load the authorization request for `id` and verify it's a pending, unexpired
/// authorization-code flow carrying both a `redirect_uri` and a PKCE
/// `code_challenge`. On success the two optional fields are unwrapped into the
/// returned [`PendingCodeRequest`]. A request whose `expires_at` has passed is
/// treated as not found — the deadline is enforced here at read time.
pub(crate) fn load_pending_code_request(
    store: &impl GrantStore,
    id: &str,
) -> Result<PendingCodeRequest, AuthorizationServerError> {
    let make_consent_not_found =
        || AuthorizationServerError::OAuthConsentNotFound { id: id.to_owned() };
    match store.authorization_request_by_id(id)? {
        Some(request)
            if request.status == RequestStatus::Pending
                && request.grant_type == GrantType::AuthorizationCode
                && request.expires_at > Utc::now() =>
        {
            PendingCodeRequest::from_request(request).ok_or_else(make_consent_not_found)
        }
        _ => Err(make_consent_not_found()),
    }
}

/// Approve an authorization-code consent prompt: clamp the Owner's ticks into a
/// [`DelegatedScopes`] proof, issue the code, record the standing grant and,
/// for a client trusted on first use, its registration, republish the popup
/// head, and return the client callback URL.
/// An approval that grants nothing is applied as a **deny**, and so is one
/// for a request whose browser session has been revoked since it was made.
///
/// A request the
/// [registration verdict](crate::domain::client_registration::ClientRegistrationVerdict)
/// finds new or changed must carry the Owner's
/// [`acknowledged_registration`](ApproveOAuthConsentInput::acknowledged_registration),
/// else it fails with
/// [`RegistrationNotAcknowledged`](AuthorizationServerError::RegistrationNotAcknowledged)
/// and nothing is written. A request whose SMART launch bound a patient must be
/// approved for that patient, else it fails with
/// [`LaunchPatientMismatch`](AuthorizationServerError::LaunchPatientMismatch) and nothing
/// is written.
pub(crate) fn approve_oauth_consent(
    store: &impl GrantStore,
    owner_approval: &dyn OwnerApproval,
    id: &str,
    input: ApproveOAuthConsentInput,
    generate_code: impl FnOnce() -> String,
    ctx: &ApprovalContext<'_>,
) -> Result<ConsentOutcome, AuthorizationServerError> {
    let now = ctx.now;
    let make_consent_not_found =
        || AuthorizationServerError::OAuthConsentNotFound { id: id.to_owned() };
    let pending_request = load_pending_code_request(store, id)?;
    let request = pending_request.request();
    let requested_redirect_uri = pending_request.redirect_uri();

    // The host app's client is held to its fixed registration; every other client is
    // trusted on first use, so its registration may be created or widened.
    let registration_is_fixed = request.client_id == ctx.wildflower_host_app_client_id;
    let maybe_existing_client = store.client_by_id(&request.client_id)?;
    if registration_is_fixed && maybe_existing_client.is_none() {
        return Err(make_consent_not_found());
    }
    let registration_verdict = classify_registration(&PresentedClientRegistration {
        maybe_existing_client: maybe_existing_client.as_ref(),
        redirect_uri: requested_redirect_uri,
        scopes: &request.requested_scopes,
    });
    if registration_verdict.needs_acknowledgement() && !input.acknowledged_registration {
        return Err(AuthorizationServerError::RegistrationNotAcknowledged { id: id.to_owned() });
    }
    if !request.admits_patient(input.patient.as_deref()) {
        return Err(AuthorizationServerError::LaunchPatientMismatch { id: id.to_owned() });
    }

    // The proof every write below demands: the Owner's approval clamped to
    // what this prompt may grant and covered by the approver's own grant.
    let Some(delegated_scopes) = DelegatedScopes::clamp(
        ctx.approver_grant,
        input.owner_approved_scopes,
        &ApprovableScopes::for_code(
            &request.requested_scopes,
            maybe_existing_client.as_ref(),
            registration_is_fixed,
        ),
    )?
    else {
        return deny_consent(store, owner_approval, id, make_consent_not_found)
            .map(|()| denial_outcome(&pending_request));
    };

    let issued_code = match RequestApprover::over(store).approve_for_code(
        CodeAuthority::OwnerDelegated(&delegated_scopes),
        &pending_request,
        input.patient.as_deref(),
        generate_code(),
        now,
    )? {
        CodeApproval::Issued(issued_code) => issued_code,
        CodeApproval::RequestNotPending => return Err(make_consent_not_found()),
        // The approver denied the request instead: tell the client so.
        CodeApproval::BrowserSessionRevoked => {
            owner_approval.republish_active();
            return Ok(denial_outcome(&pending_request));
        }
    };

    // Persist the (possibly brand-new) registration with the grant it justifies:
    // one transaction, so a client row never outlives a failed approval.
    let registration_to_widen = (!registration_is_fixed).then_some(&registration_verdict);
    GrantRecorder::over(store).record_code_grant(
        &request.client_id,
        requested_redirect_uri,
        &delegated_scopes,
        input.patient.as_deref(),
        now,
        registration_to_widen,
    )?;

    // This request was pending until the approval above flipped it out of
    // `pending`, so the newest pending consent has to be recomputed — the host
    // drops it, or moves on to the newest still pending.
    owner_approval.republish_active();

    let client_callback_url = request.client_state.as_deref().map(|client_state| {
        build_client_redirect_url(requested_redirect_uri, &issued_code.code, client_state)
    });
    Ok(ConsentOutcome::Approved {
        redirect: client_callback_url,
    })
}

/// Deny the pending authorization-code request `id`. Validates it's a live
/// code-flow prompt first (so a stale/unknown id is the structured 404), then
/// marks it denied, republishes the popup head, and returns the client's
/// `error=access_denied` callback.
pub(crate) fn deny_oauth_consent(
    store: &impl GrantStore,
    owner_approval: &dyn OwnerApproval,
    id: &str,
) -> Result<ConsentOutcome, AuthorizationServerError> {
    let pending_request = load_pending_code_request(store, id)?;
    deny_consent(store, owner_approval, id, || {
        AuthorizationServerError::OAuthConsentNotFound { id: id.to_owned() }
    })?;
    Ok(denial_outcome(&pending_request))
}

/// The outcome of denying `pending_request`: the client callback carrying
/// `error=access_denied` and the client's `state` (RFC 6749 §4.1.2.1), the
/// same one the status poll hands the wait page.
fn denial_outcome(pending_request: &PendingCodeRequest) -> ConsentOutcome {
    let client_callback_url =
        pending_request
            .request()
            .client_state
            .as_deref()
            .map(|client_state| {
                build_client_error_redirect_url(
                    pending_request.redirect_uri(),
                    OAuthErrorCode::AccessDenied,
                    client_state,
                )
            });
    ConsentOutcome::Denied {
        redirect: client_callback_url,
    }
}
