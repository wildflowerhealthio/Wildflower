//! A session widening's consent prompt, keyed by its id:
//! [`ConsentReader::session_widening_consent`] and [`ConsentDecider`]'s
//! `approve_session_widening` / `deny_session_widening`. An approval obtains a
//! [`DelegatedScopes`] proof, the Owner's ticks clamped to what the browser
//! asked for (untick only) and to the approver's own grant, and hands it to
//! the [`RequestApprover`], which approves the widening and widens its
//! browser session in the same scope. A widening records no grant: the
//! limited page's poll collects the wider session token.

use chrono::{DateTime, Utc};

use super::{ConsentDecider, ConsentOutcome, ConsentReader, SessionWideningConsentView};
use crate::domain::authority::{ApprovableScopes, DelegatedScopes};
use crate::domain::authorization_request::session_widening::SessionWideningRequest;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::writers::{RequestApprover, SessionWideningOutcome};
use crate::domain::grant_store::{AuthorizationRequestsTx, ClientsTx as _};
use crate::domain::GrantStore;

impl<S: GrantStore> ConsentReader<S> {
    /// Load the pending session widening `id` for its consent card, with the
    /// app's name resolved, the scopes the card's ticks start from, and the
    /// approval scopes the reader lacks.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::SessionWideningNotFound`] when `id` names
    /// no pending, unexpired widening; a store failure.
    pub(crate) fn session_widening_consent(
        &self,
        id: &str,
        now: DateTime<Utc>,
    ) -> Result<SessionWideningConsentView, AuthorizationServerError> {
        let (request, maybe_existing_client) = self.store.read(|tx| {
            let request = load_pending_session_widening(tx, id, now)?;
            let maybe_existing_client = tx.client_by_id(&request.client_id)?;
            Ok::<_, AuthorizationServerError>((request, maybe_existing_client))
        })?;
        let client_name = maybe_existing_client.map_or_else(
            || request.client_id.clone(),
            |existing_client| existing_client.name,
        );
        let approvable = ApprovableScopes::for_session_widening(&request.requested_scopes);
        Ok(SessionWideningConsentView {
            starting_scopes: approvable.delegable_scopes(&self.reader_grant),
            missing_approval_scopes: approvable.missing_approval_scopes(&self.reader_grant),
            request,
            client_name,
        })
    }
}

impl<S: GrantStore> ConsentDecider<S> {
    /// Approve the session widening `id` with the `owner_approved_scopes`,
    /// clamped to what the browser asked for and to the approver's own grant,
    /// widen its browser session by them, and republish the Owner prompt. An
    /// approval that grants nothing, or of a widening whose session has ended
    /// since, is applied as a **deny**.
    ///
    /// # Errors
    ///
    /// [`InsufficientScope`](AuthorizationServerError::InsufficientScope) when
    /// the approver can't decide requests, and
    /// [`InsufficientApproverScope`](AuthorizationServerError::InsufficientApproverScope)
    /// for a ticked scope beyond the approver's own grant, both writing
    /// nothing; [`SessionWideningNotFound`](AuthorizationServerError::SessionWideningNotFound)
    /// when `id` names no pending widening, or another surface decided it
    /// first.
    pub(crate) fn approve_session_widening(
        &self,
        id: &str,
        owner_approved_scopes: Vec<String>,
        now: DateTime<Utc>,
    ) -> Result<ConsentOutcome, AuthorizationServerError> {
        self.decide_and_republish(|tx| {
            let request = load_pending_session_widening(tx, id, now)?;
            let Some(delegated_scopes) = DelegatedScopes::clamp(
                &self.approver_grant,
                owner_approved_scopes,
                &ApprovableScopes::for_session_widening(&request.requested_scopes),
            )?
            else {
                deny_session_widening(tx, &request, now)?;
                return Ok(ConsentOutcome::Denied { redirect: None });
            };
            match RequestApprover::within(tx).approve_session_widening(
                &delegated_scopes,
                &request,
                &self.stale_session_cutoff,
                now,
            )? {
                SessionWideningOutcome::Widened => Ok(ConsentOutcome::Approved { redirect: None }),
                SessionWideningOutcome::BrowserSessionEnded => {
                    Ok(ConsentOutcome::Denied { redirect: None })
                }
                SessionWideningOutcome::RequestNotPending => Err(widening_not_found(id)),
            }
        })
    }

    /// Deny the session widening `id`, leaving its session as it was, and
    /// republish the Owner prompt.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::SessionWideningNotFound`] when `id` names
    /// no pending widening.
    pub(crate) fn deny_session_widening(
        &self,
        id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), AuthorizationServerError> {
        self.decide_and_republish(|tx| {
            let request = load_pending_session_widening(tx, id, now)?;
            deny_session_widening(tx, &request, now)
        })
    }
}

/// The session widening `id`, pending at `now`. Anything else is not found.
fn load_pending_session_widening(
    tx: &mut impl AuthorizationRequestsTx,
    id: &str,
    now: DateTime<Utc>,
) -> Result<SessionWideningRequest, AuthorizationServerError> {
    tx.session_widening_request_by_id(id)?
        .filter(|request| request.is_pending_at(now))
        .ok_or_else(|| widening_not_found(id))
}

/// Deny the session widening `request`, as read, at `now`, in the caller's
/// write scope `tx`: an explicit deny, or an approval that grants nothing. It
/// lands only on a widening still pending; otherwise it is not found.
fn deny_session_widening(
    tx: &mut impl AuthorizationRequestsTx,
    request: &SessionWideningRequest,
    now: DateTime<Utc>,
) -> Result<(), AuthorizationServerError> {
    let denied = request
        .deny(now)
        .map_err(|_| widening_not_found(&request.id))?;
    if tx.replace_session_widening_request(request, &denied)? {
        Ok(())
    } else {
        Err(widening_not_found(&request.id))
    }
}

/// The session widening `id` is not (or no longer) pending.
fn widening_not_found(id: &str) -> AuthorizationServerError {
    AuthorizationServerError::SessionWideningNotFound { id: id.to_owned() }
}
