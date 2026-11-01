//! The authorization-code consent prompt: [`ConsentReader::oauth_consent`],
//! [`ConsentRaiser::raise_for_owner`], and [`ConsentDecider`]'s
//! `approve_oauth_consent` / `deny_oauth_consent`. An approval obtains a
//! [`DelegatedScopes`] proof and hands it to the writers in the same scope —
//! the [`RequestApprover`] issues the code, the [`GrantRecorder`] records the
//! standing grant and (for a client trusted on first use) the registration —
//! so the code and the grant land together or not at all.

use chrono::{DateTime, Utc};

use super::{
    ApproveOAuthConsentInput, ConsentDecider, ConsentOutcome, ConsentRaiser, ConsentReader,
    OAuthConsentView, OwnerRaising,
};
use crate::domain::authority::DelegatedScopes;
use crate::domain::authorization_request::code::resolved::ResolvedCodeRequest;
use crate::domain::authorization_request::code::CodeRequest;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::authorize_refusal::AuthorizeRefusal;
use crate::domain::capabilities::writers::{
    CodeApproval, CodeAuthority, GrantRecorder, RequestApprover,
};
use crate::domain::client_redirect::{
    build_client_error_redirect_url, build_client_redirect_url, BROWSER_SIGNED_OUT_DESCRIPTION,
    REQUEST_DECLINED_DESCRIPTION,
};
use crate::domain::grant_store::{AuthorizationRequestsTx, ClientsTx};
use crate::domain::oauth_error_code::OAuthErrorCode;
use crate::domain::{GrantStore, GrantTx};

impl<S: GrantStore> ConsentReader<S> {
    /// Load a pending authorization-code consent prompt for the launcher, with
    /// the client's display name and its presented client change resolved against
    /// the current row, and the approval scopes the reader lacks.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::OAuthConsentNotFound`] when `id` names no
    /// live code-flow prompt, or its client is disabled; a store failure.
    pub(crate) fn oauth_consent(
        &self,
        id: &str,
        now: DateTime<Utc>,
    ) -> Result<OAuthConsentView, AuthorizationServerError> {
        self.store.read(|tx| {
            let pending_request = load_pending_code_request(tx, id, now)?;
            let resolved = resolve(tx, &pending_request)?;
            if resolved.is_client_disabled() {
                return Err(consent_not_found(id));
            }
            Ok(OAuthConsentView {
                missing_approval_scopes: resolved
                    .approvable_scopes()
                    .missing_approval_scopes(&self.reader_grant),
                client_name: resolved.client_name().to_owned(),
                presented_client_change: resolved.presented_client_change().clone(),
                pending_request,
            })
        })
    }
}

impl<S: GrantStore> ConsentRaiser<S> {
    /// Raise the pending authorization-code prompt `id` for the Owner and
    /// republish the Owner prompt, once `may_raise_for_owner`
    /// admits it: the authorization start limit, as for a request
    /// `/oauth/authorize` raises, so asking the Owner about request after
    /// request costs what starting them would have. A prompt not decidable in
    /// its requesting browser is already raised: nothing changes and the limit
    /// isn't asked.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::OAuthConsentNotFound`] when `id` names no
    /// live code-flow prompt, or its client is disabled (the rule on
    /// [`OwnerPrompt`](crate::domain::owner_prompt::OwnerPrompt)).
    pub(crate) fn raise_for_owner(
        &self,
        id: &str,
        may_raise_for_owner: impl FnOnce() -> bool,
        now: DateTime<Utc>,
    ) -> Result<OwnerRaising, AuthorizationServerError> {
        let raising = self.store.write(|tx| {
            let pending_request = load_pending_code_request(tx, id, now)?;
            if tx.is_client_disabled(&pending_request.client_id)? {
                return Err(consent_not_found(id));
            }
            if !pending_request.decidable_in_requesting_browser {
                return Ok(OwnerRaising::AlreadyRaised);
            }
            if !may_raise_for_owner() {
                return Ok(OwnerRaising::StartLimited);
            }
            let raised = pending_request
                .raise_for_owner(now)
                .map_err(|_| consent_not_found(id))?;
            if tx.replace_code_request(&pending_request, &raised)? {
                Ok(OwnerRaising::Raised)
            } else {
                Err(consent_not_found(id))
            }
        })?;
        if raising == OwnerRaising::Raised {
            self.owner_approval.republish_active();
        }
        Ok(raising)
    }
}

impl<S: GrantStore> ConsentDecider<S> {
    /// Approve the authorization-code consent prompt `id`: clamp the Owner's
    /// ticks into a [`DelegatedScopes`] proof (which requires the approver's
    /// approval scopes), issue the code, record the standing grant and, for a
    /// client trusted on first use, its registration, all in one write scope,
    /// so the code, the grant and the registration land together or not at
    /// all; once it commits, republish the Owner prompt and return the client
    /// callback URL. An approval that grants nothing is applied as a **deny**, and so is
    /// one for a request whose browser session has ended or whose client was
    /// disabled since it was made.
    ///
    /// # Errors
    ///
    /// Each refusal writes nothing.
    /// [`InsufficientScope`](AuthorizationServerError::InsufficientScope) names
    /// the approval scopes the approver lacks (see
    /// [`ApprovableScopes::missing_approval_scopes`](crate::domain::authority::ApprovableScopes::missing_approval_scopes));
    /// [`RegistrationNotAcknowledged`](AuthorizationServerError::RegistrationNotAcknowledged)
    /// when the
    /// [presented client change](crate::domain::client::presented_change::PresentedClientChange)
    /// finds the request new or changed and the Owner didn't
    /// [acknowledge](ApproveOAuthConsentInput::acknowledged_registration_change) it;
    /// [`LaunchPatientMismatch`](AuthorizationServerError::LaunchPatientMismatch)
    /// when the request's SMART launch bound another patient;
    /// [`OAuthConsentNotFound`](AuthorizationServerError::OAuthConsentNotFound)
    /// when `id` names no live code-flow prompt.
    pub(crate) fn approve_oauth_consent(
        &self,
        id: &str,
        input: ApproveOAuthConsentInput,
        generate_code: impl FnOnce() -> String,
        now: DateTime<Utc>,
    ) -> Result<ConsentOutcome, AuthorizationServerError> {
        self.decide_and_republish(|tx| self.approve_oauth_in(tx, id, input, generate_code, now))
    }

    /// Deny the authorization-code consent prompt `id`, republish the popup
    /// head, and return the client's `error=access_denied` callback.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::OAuthConsentNotFound`] when `id` names no
    /// live code-flow prompt.
    pub(crate) fn deny_oauth_consent(
        &self,
        id: &str,
        now: DateTime<Utc>,
    ) -> Result<ConsentOutcome, AuthorizationServerError> {
        self.decide_and_republish(|tx| {
            let pending_request = load_pending_code_request(tx, id, now)?;
            deny_pending_request(tx, &pending_request, now, id)?;
            Ok(denial_outcome(
                &pending_request,
                REQUEST_DECLINED_DESCRIPTION,
            ))
        })
    }

    /// [`approve_oauth_consent`](Self::approve_oauth_consent)'s flow, inside its write scope
    /// `tx`. The checks run in order: a disabled client's prompt is denied;
    /// the [`DelegatedScopes`] proof comes first after that, so an approver
    /// lacking an approval scope is refused before anything else; then the
    /// acknowledgement of a registration change; then the launch's patient.
    /// Each refusal is an error that writes nothing, and only then does a
    /// clamp that left nothing become a deny.
    fn approve_oauth_in(
        &self,
        tx: &mut impl GrantTx,
        id: &str,
        input: ApproveOAuthConsentInput,
        generate_code: impl FnOnce() -> String,
        now: DateTime<Utc>,
    ) -> Result<ConsentOutcome, AuthorizationServerError> {
        let pending_request = load_pending_code_request(tx, id, now)?;
        let requested_redirect_uri = &pending_request.redirect_uri;
        let resolved = resolve(tx, &pending_request)?;
        // The client was disabled since the request was made: it can't be
        // approved, so it ends here, and the app hears why.
        if resolved.is_client_disabled() {
            deny_pending_request(tx, &pending_request, now, id)?;
            return Ok(denial_outcome(
                &pending_request,
                AuthorizeRefusal::DisabledClient.description(),
            ));
        }
        // The proof every write below demands: the approver holds this prompt's
        // approval scopes, and the Owner's approval is clamped to what this
        // prompt may grant and covered by the approver's own grant. Taken
        // first, so an approver lacking an approval scope is refused before
        // anything else.
        let maybe_delegated_scopes = DelegatedScopes::clamp(
            &self.approver_grant,
            input.owner_approved_scopes,
            resolved.approvable_scopes(),
        )?;
        if resolved
            .presented_client_change()
            .would_change_registration()
            && !input.acknowledged_registration_change
        {
            return Err(AuthorizationServerError::RegistrationNotAcknowledged {
                id: id.to_owned(),
            });
        }
        if !pending_request.admits_patient(input.patient.as_deref()) {
            return Err(AuthorizationServerError::LaunchPatientMismatch { id: id.to_owned() });
        }
        let Some(delegated_scopes) = maybe_delegated_scopes else {
            deny_pending_request(tx, &pending_request, now, id)?;
            return Ok(denial_outcome(
                &pending_request,
                REQUEST_DECLINED_DESCRIPTION,
            ));
        };

        let issued_code = match RequestApprover::within(tx).approve_for_code(
            CodeAuthority::OwnerDelegated(&delegated_scopes),
            &pending_request,
            input.patient.as_deref(),
            generate_code(),
            &self.stale_session_cutoff,
            now,
        )? {
            CodeApproval::Issued(issued_code) => issued_code,
            CodeApproval::RequestNotPending => return Err(consent_not_found(id)),
            // The approver denied the request instead: tell the client so.
            CodeApproval::BrowserSessionEnded => {
                return Ok(denial_outcome(
                    &pending_request,
                    BROWSER_SIGNED_OUT_DESCRIPTION,
                ));
            }
        };
        GrantRecorder::within(tx).record_code_grant(
            &pending_request.client_id,
            requested_redirect_uri,
            &delegated_scopes,
            input.patient.as_deref(),
            now,
        )?;
        Ok(ConsentOutcome::Approved {
            redirect: Some(build_client_redirect_url(
                requested_redirect_uri,
                &issued_code.code,
                &pending_request.client_state,
            )),
        })
    }
}

/// The code-flow prompt `id`, pending at `now`: the Owner can't read,
/// approve, deny or be asked about a request still waiting on its browser's
/// limited page. Anything else is not found.
pub(super) fn load_pending_code_request(
    tx: &mut impl AuthorizationRequestsTx,
    id: &str,
    now: DateTime<Utc>,
) -> Result<CodeRequest, AuthorizationServerError> {
    tx.code_request_by_id(id)?
        .filter(|request| request.is_pending_at(now))
        .ok_or_else(|| consent_not_found(id))
}

/// Deny the prompt `id`, `pending_request` as read, at `now`, in the caller's
/// write scope `tx` — the shared tail of every deny path (an explicit deny,
/// an approval that grants nothing, and one for a client disabled since).
///
/// The deny lands only on a request still pending: when another surface
/// decided it first (or it expired) since it was read, nothing changes and
/// the prompt is not found, as an approval that loses the same race is.
fn deny_pending_request(
    tx: &mut impl AuthorizationRequestsTx,
    pending_request: &CodeRequest,
    now: DateTime<Utc>,
    id: &str,
) -> Result<(), AuthorizationServerError> {
    let denied = pending_request
        .to_denied(now)
        .map_err(|_| consent_not_found(id))?;
    if tx.replace_code_request(pending_request, &denied)? {
        Ok(())
    } else {
        Err(consent_not_found(id))
    }
}

/// `pending_request` resolved against its client's registration as `tx`
/// holds it now.
fn resolve(
    tx: &mut impl ClientsTx,
    pending_request: &CodeRequest,
) -> Result<ResolvedCodeRequest, AuthorizationServerError> {
    let maybe_existing_client = tx.client_by_id(&pending_request.client_id)?;
    Ok(ResolvedCodeRequest::resolve(
        &pending_request.client_id,
        &pending_request.redirect_uri,
        &pending_request.requested_scopes,
        maybe_existing_client.as_ref(),
    ))
}

/// The code-flow prompt `id` is not (or no longer) a live prompt.
fn consent_not_found(id: &str) -> AuthorizationServerError {
    AuthorizationServerError::OAuthConsentNotFound { id: id.to_owned() }
}

/// The outcome of denying `pending_request`: the client callback carrying
/// `error=access_denied`, `description` as its `error_description`, and the
/// client's `state` (RFC 6749 §4.1.2.1).
fn denial_outcome(pending_request: &CodeRequest, description: &str) -> ConsentOutcome {
    ConsentOutcome::Denied {
        redirect: Some(build_client_error_redirect_url(
            &pending_request.redirect_uri,
            OAuthErrorCode::AccessDenied,
            description,
            &pending_request.client_state,
        )),
    }
}
