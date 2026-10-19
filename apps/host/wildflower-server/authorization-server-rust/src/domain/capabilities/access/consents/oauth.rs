//! The authorization-code consent prompt: [`ConsentReader::oauth_consent`],
//! [`ConsentRaiser::raise_for_owner`], and [`ConsentDecider`]'s
//! `approve_oauth_consent` / `deny_oauth_consent`. An approval obtains a
//! [`DelegatedScopes`] proof and hands it to the writers in the same scope —
//! the [`RequestApprover`] issues the code, the [`GrantRecorder`] records the
//! standing grant and (for a client trusted on first use) the registration —
//! so the code and the grant land together or not at all.

use chrono::{DateTime, Utc};

use super::delegation::deny_pending_request;
use super::{
    ApproveOAuthConsentInput, ConsentDecider, ConsentOutcome, ConsentRaiser, ConsentReader,
    OAuthConsentView, OwnerRaising,
};
use crate::domain::authority::DelegatedScopes;
use crate::domain::authorization_request::PendingCodeRequest;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::writers::{
    CodeApproval, CodeAuthority, GrantRecorder, RequestApprover,
};
use crate::domain::client_redirect::{
    build_client_error_redirect_url, build_client_redirect_url, BROWSER_SIGNED_OUT_DESCRIPTION,
    REQUEST_DECLINED_DESCRIPTION,
};
use crate::domain::client_registration::ResolvedCodeRequest;
use crate::domain::grant_store::{write_transition, AuthorizationRequestsTx, ClientsTx};
use crate::domain::oauth_error_code::OAuthErrorCode;
use crate::domain::oauth_error_kind::OAuthErrorKind;
use crate::domain::{GrantStore, GrantTx};

impl<S: GrantStore> ConsentReader<S> {
    /// Load a pending authorization-code consent prompt for the launcher, with
    /// the client's display name and its registration verdict resolved against
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
            if resolved.client_disabled() {
                return Err(consent_not_found(id));
            }
            Ok(OAuthConsentView {
                missing_approval_scopes: resolved
                    .approvable_scopes()
                    .missing_approval_scopes(&self.reader_grant),
                client_name: resolved.client_name().to_owned(),
                registration_verdict: resolved.registration_verdict().clone(),
                pending_request,
            })
        })
    }
}

impl<S: GrantStore> ConsentRaiser<S> {
    /// Raise the pending authorization-code prompt `id` for the Owner and
    /// republish the newest pending consent, once `may_raise_for_owner`
    /// admits it: the authorization start limit, as for a request
    /// `/oauth/authorize` raises, so asking the Owner about request after
    /// request costs what starting them would have. A prompt not decidable in
    /// its requesting browser is already raised: nothing changes and the limit
    /// isn't asked.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::OAuthConsentNotFound`] when `id` names no
    /// live code-flow prompt.
    pub(crate) fn raise_for_owner(
        &self,
        id: &str,
        may_raise_for_owner: impl FnOnce() -> bool,
        now: DateTime<Utc>,
    ) -> Result<OwnerRaising, AuthorizationServerError> {
        let raising = self.store.write(|tx| {
            let pending_request = load_pending_code_request(tx, id, now)?;
            if !pending_request.code().decidable_in_requesting_browser {
                return Ok(OwnerRaising::AlreadyRaised);
            }
            if !may_raise_for_owner() {
                return Ok(OwnerRaising::StartLimited);
            }
            if write_transition(tx, pending_request.request().raise_for_owner(now))? {
                Ok(OwnerRaising::Raised)
            } else {
                Err(AuthorizationServerError::OAuthConsentNotFound { id: id.to_owned() })
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
    /// client trusted on first use, its registration, then republish the
    /// popup head and return the client callback URL, all in one write scope,
    /// so the code, the grant and the registration land together or not at
    /// all. An approval that grants nothing is applied as a **deny**, and so is
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
    /// [registration verdict](crate::domain::client_registration::ClientRegistrationVerdict)
    /// finds the request new or changed and the Owner didn't
    /// [acknowledge](ApproveOAuthConsentInput::acknowledged_registration) it;
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
            deny_pending_request(tx, pending_request.request(), now, || consent_not_found(id))?;
            Ok(denial_outcome(
                &pending_request,
                REQUEST_DECLINED_DESCRIPTION,
            ))
        })
    }

    /// [`approve_oauth_consent`](Self::approve_oauth_consent)'s flow, inside its write scope
    /// `tx`.
    fn approve_oauth_in(
        &self,
        tx: &mut impl GrantTx,
        id: &str,
        input: ApproveOAuthConsentInput,
        generate_code: impl FnOnce() -> String,
        now: DateTime<Utc>,
    ) -> Result<ConsentOutcome, AuthorizationServerError> {
        let pending_request = load_pending_code_request(tx, id, now)?;
        let request = pending_request.request();
        let requested_redirect_uri = &pending_request.code().redirect_uri;
        let resolved = resolve(tx, &pending_request)?;
        // The client was disabled since the request was made: it can't be
        // approved, so it ends here, and the app hears why.
        if resolved.client_disabled() {
            deny_pending_request(tx, request, now, || consent_not_found(id))?;
            return Ok(denial_outcome(
                &pending_request,
                OAuthErrorKind::DisabledClient.description(),
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
        if resolved.registration_verdict().needs_acknowledgement()
            && !input.acknowledged_registration
        {
            return Err(AuthorizationServerError::RegistrationNotAcknowledged {
                id: id.to_owned(),
            });
        }
        if !pending_request
            .code()
            .admits_patient(input.patient.as_deref())
        {
            return Err(AuthorizationServerError::LaunchPatientMismatch { id: id.to_owned() });
        }
        let Some(delegated_scopes) = maybe_delegated_scopes else {
            deny_pending_request(tx, request, now, || consent_not_found(id))?;
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
            request.client_id(),
            requested_redirect_uri,
            &delegated_scopes,
            input.patient.as_deref(),
            now,
        )?;
        Ok(ConsentOutcome::Approved {
            redirect: Some(build_client_redirect_url(
                requested_redirect_uri,
                &issued_code.code,
                &pending_request.code().client_state,
            )),
        })
    }
}

/// The code-flow prompt `id`, pending at `now` and past its browser's
/// limited page (`session_shortfall_acknowledged`): the Owner can't read,
/// approve, deny or be asked about a request its own browser hasn't gone on
/// with. Anything else is not found.
pub(super) fn load_pending_code_request(
    tx: &mut impl AuthorizationRequestsTx,
    id: &str,
    now: DateTime<Utc>,
) -> Result<PendingCodeRequest, AuthorizationServerError> {
    tx.authorization_request_by_id(id)?
        .and_then(|request| request.into_pending_code(now))
        .filter(|pending_request| pending_request.code().session_shortfall_acknowledged)
        .ok_or_else(|| consent_not_found(id))
}

/// `pending_request` resolved against its client's registration as `tx`
/// holds it now.
fn resolve(
    tx: &mut impl ClientsTx,
    pending_request: &PendingCodeRequest,
) -> Result<ResolvedCodeRequest, AuthorizationServerError> {
    let request = pending_request.request();
    let maybe_existing_client = tx.client_by_id(request.client_id())?;
    Ok(ResolvedCodeRequest::resolve(
        request.client_id(),
        &pending_request.code().redirect_uri,
        request.requested_scopes(),
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
fn denial_outcome(pending_request: &PendingCodeRequest, description: &str) -> ConsentOutcome {
    let code_request = pending_request.code();
    ConsentOutcome::Denied {
        redirect: Some(build_client_error_redirect_url(
            &code_request.redirect_uri,
            OAuthErrorCode::AccessDenied,
            description,
            &code_request.client_state,
        )),
    }
}
