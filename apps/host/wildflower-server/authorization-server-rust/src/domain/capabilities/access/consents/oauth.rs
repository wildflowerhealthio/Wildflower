//! The authorization-code consent prompt: [`ConsentReader::oauth_consent`],
//! [`ConsentRaiser::raise_for_owner`], and [`ConsentDecider`]'s
//! `approve_oauth` / `deny_oauth`. An approval obtains a [`DelegatedScopes`]
//! proof and hands it to the writers in the same scope — the
//! [`RequestApprover`] issues the code, the [`GrantRecorder`] records the
//! standing grant and (for a client trusted on first use) the registration —
//! so the code and the grant land together or not at all.

use chrono::{DateTime, Utc};

use super::delegation::deny_pending_request;
use super::{
    ApproveOAuthConsentInput, ConsentDecider, ConsentOutcome, ConsentRaiser, ConsentReader,
    OAuthConsentView, OwnerRaising,
};
use crate::domain::authority::{ApprovableScopes, DelegatedScopes};
use crate::domain::authorization_code::PendingCodeRequest;
use crate::domain::authorization_request::{GrantType, RequestStatus};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::writers::{
    CodeApproval, CodeAuthority, GrantRecorder, RequestApprover,
};
use crate::domain::client_redirect::{
    build_client_error_redirect_url, build_client_redirect_url, BROWSER_SIGNED_OUT_DESCRIPTION,
    REQUEST_DECLINED_DESCRIPTION,
};
use crate::domain::client_registration::{classify_registration, PresentedClientRegistration};
use crate::domain::grant_store::{AuthorizationRequestsTx, ClientsTx as _};
use crate::domain::oauth_error_code::OAuthErrorCode;
use crate::domain::{GrantStore, GrantTx};

impl<S: GrantStore> ConsentReader<S> {
    /// Load a pending authorization-code consent prompt for the launcher, with
    /// the client's display name and its registration verdict resolved against
    /// the current row, and the approval scopes the reader lacks.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::OAuthConsentNotFound`] when `id` names no
    /// live code-flow prompt; a store failure.
    pub(crate) fn oauth_consent(
        &self,
        id: &str,
    ) -> Result<OAuthConsentView, AuthorizationServerError> {
        self.store.read(|tx| {
            let pending_request = load_pending_code_request(tx, id, Utc::now())?;
            let requested_redirect_uri = pending_request.redirect_uri().clone();
            let request = pending_request.into_request();
            // A missing row is the `New` verdict, and its name falls back to the
            // raw `client_id`.
            let maybe_existing_client = tx.client_by_id(&request.client_id)?;
            let client_name = maybe_existing_client.as_ref().map_or_else(
                || request.client_id.clone(),
                |existing_client| existing_client.name.clone(),
            );
            let registration_verdict = classify_registration(&PresentedClientRegistration {
                maybe_existing_client: maybe_existing_client.as_ref(),
                redirect_uri: &requested_redirect_uri,
                scopes: &request.requested_scopes,
            });
            let missing_approval_scopes = ApprovableScopes::for_code(
                &request.requested_scopes,
                maybe_existing_client.as_ref(),
                request.client_id == *self.wildflower_host_app_client_id,
            )
            .missing_approval_scopes(&self.reader_grant);
            Ok(OAuthConsentView {
                request,
                requested_redirect_uri,
                client_name,
                registration_verdict,
                missing_approval_scopes,
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
    ) -> Result<OwnerRaising, AuthorizationServerError> {
        let raising = self.store.write(|tx| {
            let pending_request = load_pending_code_request(tx, id, Utc::now())?;
            if !pending_request.request().decidable_in_requesting_browser {
                return Ok(OwnerRaising::AlreadyRaised);
            }
            if !may_raise_for_owner() {
                return Ok(OwnerRaising::StartLimited);
            }
            if tx.raise_authorization_request_for_owner(id)? {
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
    /// popup head and return the client callback URL. An approval that grants
    /// nothing is applied as a **deny**, and so is one for a request whose
    /// browser session has ended since it was made.
    ///
    /// # Errors
    ///
    /// Each refusal writes nothing.
    /// [`InsufficientScope`](AuthorizationServerError::InsufficientScope) names
    /// the approval scopes the approver lacks (see
    /// [`ApprovableScopes::missing_approval_scopes`]);
    /// [`RegistrationNotAcknowledged`](AuthorizationServerError::RegistrationNotAcknowledged)
    /// when the
    /// [registration verdict](crate::domain::client_registration::ClientRegistrationVerdict)
    /// finds the request new or changed and the Owner didn't
    /// [acknowledge](ApproveOAuthConsentInput::acknowledged_registration) it;
    /// [`LaunchPatientMismatch`](AuthorizationServerError::LaunchPatientMismatch)
    /// when the request's SMART launch bound another patient;
    /// [`OAuthConsentNotFound`](AuthorizationServerError::OAuthConsentNotFound)
    /// when `id` names no live code-flow prompt.
    pub(crate) fn approve_oauth(
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
    pub(crate) fn deny_oauth(&self, id: &str) -> Result<ConsentOutcome, AuthorizationServerError> {
        self.decide_and_republish(|tx| {
            let pending_request = load_pending_code_request(tx, id, Utc::now())?;
            deny_pending_request(tx, id, || consent_not_found(id))?;
            Ok(denial_outcome(
                &pending_request,
                REQUEST_DECLINED_DESCRIPTION,
            ))
        })
    }

    /// [`approve_oauth`](Self::approve_oauth)'s flow, inside its write scope
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
        let requested_redirect_uri = pending_request.redirect_uri();

        // The host app's client is held to its fixed registration; every other
        // client is trusted on first use, so its registration may be created or
        // widened.
        let registration_is_fixed = request.client_id == *self.wildflower_host_app_client_id;
        let maybe_existing_client = tx.client_by_id(&request.client_id)?;
        if registration_is_fixed && maybe_existing_client.is_none() {
            return Err(consent_not_found(id));
        }
        let registration_verdict = classify_registration(&PresentedClientRegistration {
            maybe_existing_client: maybe_existing_client.as_ref(),
            redirect_uri: requested_redirect_uri,
            scopes: &request.requested_scopes,
        });
        // The proof every write below demands: the approver holds this prompt's
        // approval scopes, and the Owner's approval is clamped to what this
        // prompt may grant and covered by the approver's own grant. Taken
        // first, so an approver lacking an approval scope is refused before
        // anything else.
        let maybe_delegated_scopes = DelegatedScopes::clamp(
            &self.approver_grant,
            input.owner_approved_scopes,
            &ApprovableScopes::for_code(
                &request.requested_scopes,
                maybe_existing_client.as_ref(),
                registration_is_fixed,
            ),
        )?;
        if registration_verdict.needs_acknowledgement() && !input.acknowledged_registration {
            return Err(AuthorizationServerError::RegistrationNotAcknowledged {
                id: id.to_owned(),
            });
        }
        if !request.admits_patient(input.patient.as_deref()) {
            return Err(AuthorizationServerError::LaunchPatientMismatch { id: id.to_owned() });
        }
        let Some(delegated_scopes) = maybe_delegated_scopes else {
            deny_pending_request(tx, id, || consent_not_found(id))?;
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
            &request.client_id,
            requested_redirect_uri,
            &delegated_scopes,
            input.patient.as_deref(),
            now,
        )?;
        Ok(ConsentOutcome::Approved {
            redirect: Some(build_client_redirect_url(
                requested_redirect_uri,
                &issued_code.code,
                pending_request.client_state(),
            )),
        })
    }
}

/// Load the authorization request for `id` and verify it's a pending, unexpired
/// authorization-code flow carrying both a `redirect_uri` and a PKCE
/// `code_challenge`. On success the two optional fields are unwrapped into the
/// returned [`PendingCodeRequest`]. A request whose `expires_at` has passed at
/// `now` is treated as not found — the deadline is enforced here at read time.
/// So is one still waiting on its browser's limited page
/// (`session_shortfall_acknowledged` unset): the Owner can't read, approve,
/// deny or be asked about a request its own browser hasn't gone on with.
pub(super) fn load_pending_code_request(
    tx: &mut impl AuthorizationRequestsTx,
    id: &str,
    now: DateTime<Utc>,
) -> Result<PendingCodeRequest, AuthorizationServerError> {
    match tx.authorization_request_by_id(id)? {
        Some(request)
            if request.status == RequestStatus::Pending
                && request.grant_type == GrantType::AuthorizationCode
                && request.session_shortfall_acknowledged
                && request.expires_at > now =>
        {
            PendingCodeRequest::from_request(request).ok_or_else(|| consent_not_found(id))
        }
        _ => Err(consent_not_found(id)),
    }
}

/// The code-flow prompt `id` is not (or no longer) a live prompt.
fn consent_not_found(id: &str) -> AuthorizationServerError {
    AuthorizationServerError::OAuthConsentNotFound { id: id.to_owned() }
}

/// The outcome of denying `pending_request`: the client callback carrying
/// `error=access_denied`, `description` as its `error_description`, and the
/// client's `state` (RFC 6749 §4.1.2.1).
fn denial_outcome(pending_request: &PendingCodeRequest, description: &str) -> ConsentOutcome {
    ConsentOutcome::Denied {
        redirect: Some(build_client_error_redirect_url(
            pending_request.redirect_uri(),
            OAuthErrorCode::AccessDenied,
            description,
            pending_request.client_state(),
        )),
    }
}
