//! Authorization-code consent: load/approve/deny the code-flow prompt. An
//! approval obtains a [`DelegatedScopes`] proof and hands it to the writers —
//! the [`RequestApprover`] issues the code, the [`GrantRecorder`] records the
//! standing grant and (for a client trusted on first use) the registration.

use std::collections::HashSet;

use chrono::{DateTime, Utc};

use super::delegation::deny_consent;
use super::{ApproveOAuthConsentInput, ConsentOutcome, RegistrationContext};
use crate::domain::authority::{DelegatedScopes, ScopeCeiling};
use crate::domain::authorization_code::PendingCodeConsent;
use crate::domain::authorization_request::{GrantType, RequestStatus};
use crate::domain::capabilities::writers::{
    CodeApproval, CodeAuthority, GrantRecorder, RegistrationWrite, RequestApprover,
};
use crate::domain::client_redirect::build_client_redirect_url;
use crate::domain::client_registration::ClientRegistration;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::GatekeeperStore;
use crate::ports::PendingConsentPublisher;
use scopes_rust::Grant;

/// Everything an approval needs beyond the prompt itself: who is approving, how
/// to judge the client's registration, and the instant the writes are stamped
/// with. Bundled (rather than four more parameters) so
/// [`approve_oauth_consent`]'s signature stays readable.
pub(super) struct ApprovalContext<'a> {
    /// The deciding Owner's own granted scopes — the ceiling on what the
    /// approval may delegate (see [`DelegatedScopes::clamp`]).
    pub(super) approver: &'a Grant,
    /// The request-scoped inputs the registration verdict is computed from.
    pub(super) registration: &'a RegistrationContext<'a>,
    /// The instant stamped onto the code and the standing grant.
    pub(super) now: DateTime<Utc>,
}

/// Load the authorization request for `id` and verify it's a pending, unexpired
/// authorization-code flow carrying both a `redirect_uri` and a PKCE
/// `code_challenge`. On success the two optional fields are unwrapped into the
/// returned [`PendingCodeConsent`]. A request whose `expires_at` has passed is
/// treated as not found — the deadline is enforced here at read time.
pub(super) fn load_pending_authorization_code_request(
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

/// Approve an authorization-code consent prompt: judge the client's
/// registration, narrow the approved scopes to the grantable set, transition the
/// request, mint and persist the authorization code the polling endpoint hands
/// back, register-or-widen the client and refresh the standing grant, republish
/// the popup head, and return the client callback URL. An approval that grants
/// nothing is applied as a **deny**.
///
/// Two authority checks stand between the Owner's click and a grant.
/// `ctx.approver` is the deciding Owner's granted scopes — the approval can't
/// delegate a resource scope the approver doesn't hold, which is what the
/// [`DelegatedScopes`] proof the writers demand stands for. And a
/// [`New`](ClientRegistration::New) or [`Changed`](ClientRegistration::Changed)
/// registration must carry the Owner's
/// [`acknowledged_registration`](ApproveOAuthConsentInput::acknowledged_registration);
/// without it the approval fails with
/// [`RegistrationNotAcknowledged`](GatekeeperError::RegistrationNotAcknowledged)
/// and nothing is written.
///
/// The scope clamp's ceiling is the registered `allowed_scopes` for the
/// first-party host and `allowed_scopes ∪ requested_scopes` for every other
/// client (the approval then widens the registration to what was granted).
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
    let PendingCodeConsent {
        request,
        redirect_uri,
        code_challenge,
    } = load_pending_authorization_code_request(store, id)?;

    let is_first_party = ctx.registration.is_first_party(&request.client_id);
    let maybe_existing_client = store.client_by_id(&request.client_id)?;
    // The first-party host must be registered; every other client may be new.
    if is_first_party && maybe_existing_client.is_none() {
        return Err(make_consent_not_found());
    }
    let registration = ctx.registration.classify(
        &request.client_id,
        maybe_existing_client.as_ref(),
        &redirect_uri,
        &request.requested_scopes,
    );
    if registration.needs_acknowledgement() && !input.acknowledged_registration {
        return Err(GatekeeperError::RegistrationNotAcknowledged { id: id.to_owned() });
    }

    let requested: HashSet<&str> = request
        .requested_scopes
        .iter()
        .map(String::as_str)
        .collect();
    let registered: Vec<&str> = maybe_existing_client
        .as_ref()
        .map(|client| client.allowed_scopes.iter().map(String::as_str).collect())
        .unwrap_or_default();
    // The ceiling: the registration alone for the first-party host, else the
    // registration widened by what this request asked for.
    let allowed: HashSet<&str> = if is_first_party {
        registered.into_iter().collect()
    } else {
        registered
            .into_iter()
            .chain(requested.iter().copied())
            .collect()
    };
    // The proof every write below demands: the Owner's ticks clamped to the
    // ceiling and covered by the approver's own grant.
    let Some(delegated) = DelegatedScopes::clamp(
        ctx.approver,
        input.approved_scopes,
        &ScopeCeiling {
            requested: &requested,
            allowed: &allowed,
        },
    )?
    else {
        return deny_consent(store, publisher, id).map(|()| ConsentOutcome::Denied);
    };

    let Some(authorization_code) = RequestApprover::over(store).approve_for_code(
        CodeAuthority::OwnerDelegated(&delegated),
        CodeApproval {
            request_id: id,
            client_id: &request.client_id,
            redirect_uri: &redirect_uri,
            code_challenge: &code_challenge,
            patient: input.patient.as_deref(),
            code: generate_code(),
            now,
        },
    )?
    else {
        return Err(make_consent_not_found());
    };

    // Persist the (possibly brand-new) registration with the grant it justifies:
    // one transaction, so a client row never outlives a failed approval.
    let registration_write = if is_first_party {
        RegistrationWrite::Untouched
    } else {
        RegistrationWrite::Widen {
            redirect_is_new: matches!(
                registration,
                ClientRegistration::New
                    | ClientRegistration::Changed {
                        redirect_uri_is_new: true,
                        ..
                    }
            ),
        }
    };
    GrantRecorder::over(store).record_code_grant(
        &request.client_id,
        &redirect_uri,
        &delegated,
        input.patient.as_deref(),
        now,
        &registration_write,
    )?;

    // This request was the popup head (or queued behind one) until the approval
    // above flipped it out of `pending`, so the head has to be recomputed — the
    // popup must close, or advance to whatever was queued behind it.
    publisher.republish_active();

    let redirect = request.client_state.as_deref().map(|client_state| {
        build_client_redirect_url(&redirect_uri, &authorization_code.code, client_state)
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
    load_pending_authorization_code_request(store, id)?;
    deny_consent(store, publisher, id)
}
