//! Authorization-code consent: load/approve/deny the code-flow prompt and the
//! standing authorization-code grant its approval upserts.

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use scopes_rust::{grantable_scopes, Grant};
use uuid::Uuid;

use super::delegation::{deny_consent, ensure_approver_covers};
use super::{ApproveOAuthConsentInput, ConsentOutcome};
use crate::domain::authorization_code::{
    AuthorizationCode, PendingCodeConsent, AUTHORIZATION_CODE_TTL,
};
use crate::domain::authorization_request::{GrantType, RequestStatus};
use crate::domain::client_redirect::build_client_redirect_url;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::grant::{AuthorizationCodeGrant, CumulativeConsent};
use crate::domain::{GatekeeperStore, GatekeeperTx};
use crate::ports::DeviceUserCodePublisher;

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

/// Insert or cumulatively update the standing authorization-code grant for
/// `(client_id, redirect_uri)`, all inside one `BEGIN IMMEDIATE` transaction:
/// read the standing grant; if present, fold the re-approval in via
/// [`CumulativeConsent::absorb_reapproval`] and write it back; otherwise mint a
/// fresh grant. `BEGIN IMMEDIATE` takes the write lock before the read, so two
/// concurrent approvals serialise at the read rather than both reading the
/// pre-merge row and one losing its scope union.
pub(super) fn upsert_authorization_code_grant(
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

/// Approve an authorization-code consent prompt: narrow the approved scopes to
/// the requested-and-allowed set, transition the request, mint and persist the
/// authorization code the polling endpoint hands back, refresh the standing
/// grant, and return the client callback URL. An approval that grants nothing is
/// applied as a **deny**. `approver` is the deciding Owner's granted scopes — the
/// approval can't delegate a resource scope the approver doesn't hold (see
/// [`ensure_approver_covers`]).
pub(super) fn approve_oauth_consent(
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

/// Deny the pending authorization-code request `id`. Validates it's a live
/// code-flow prompt first (so a stale/unknown id is the structured 404), then
/// marks it denied and republishes the popup head.
pub(super) fn deny_oauth_consent(
    store: &impl GatekeeperStore,
    publisher: &dyn DeviceUserCodePublisher,
    id: &str,
) -> Result<(), GatekeeperError> {
    load_pending_authorization_code_request(store, id)?;
    deny_consent(store, publisher, id)
}
