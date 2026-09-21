//! Authorization-code consent: load/approve/deny the code-flow prompt, and the
//! standing authorization-code grant — plus, for a client trusted on first use,
//! the `clients` row itself — that its approval upserts.

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use scopes_rust::{grantable_scopes, Grant};
use uuid::Uuid;

use super::delegation::{deny_consent, ensure_approver_covers};
use super::{ApproveOAuthConsentInput, ConsentOutcome, RegistrationContext};
use crate::domain::authorization_code::{
    AuthorizationCode, PendingCodeConsent, AUTHORIZATION_CODE_TTL,
};
use crate::domain::authorization_request::{GrantType, RequestStatus};
use crate::domain::client::{AllowedGrantType, Client, ClientKind, RegisteredRedirectUri};
use crate::domain::client_redirect::build_client_redirect_url;
use crate::domain::client_registration::ClientRegistration;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::grant::{AuthorizationCodeGrant, CumulativeConsent};
use crate::domain::{GatekeeperStore, GatekeeperTx};
use crate::ports::DeviceUserCodePublisher;

/// Everything an approval needs beyond the prompt itself: who is approving, how
/// to judge the client's registration, and the instant the writes are stamped
/// with. Bundled (rather than four more parameters) so
/// [`approve_oauth_consent`]'s signature stays readable.
pub(super) struct ApprovalContext<'a> {
    /// The deciding Owner's own granted scopes — the ceiling on what the
    /// approval may delegate (see [`ensure_approver_covers`]).
    pub(super) approver: &'a Grant,
    /// The request-scoped inputs the registration verdict is computed from.
    pub(super) registration: &'a RegistrationContext<'a>,
    /// The instant stamped onto the code and the standing grant.
    pub(super) now: DateTime<Utc>,
}

/// What an approval writes to the `clients` row alongside the standing grant.
pub(super) enum RegistrationWrite {
    /// Leave the row untouched — the first-party host, whose registration an
    /// approval never widens.
    Untouched,
    /// Trust this client on first use: create the row when absent, otherwise
    /// widen it in place.
    Widen {
        /// Whether the approved `redirect_uri` resolves to no existing allowlist
        /// entry and so must be appended as an absolute one.
        redirect_is_new: bool,
    },
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

/// Register (or widen) the client and insert or cumulatively update the standing
/// authorization-code grant for `(client_id, redirect_uri)`, all inside one
/// `BEGIN IMMEDIATE` transaction: apply `registration` to the `clients` row, then
/// read the standing grant — if present, fold the re-approval in via
/// [`CumulativeConsent::absorb_reapproval`] and write it back; otherwise mint a
/// fresh grant. `BEGIN IMMEDIATE` takes the write lock before the read, so two
/// concurrent approvals serialise at the read rather than both reading the
/// pre-merge row and one losing its scope union — and the registration lands with
/// the grant it justifies or not at all.
///
/// `scopes` are the **granted** scopes, so a scope the Owner pruned is never
/// added to the registration.
pub(super) fn upsert_authorization_code_grant(
    store: &impl GatekeeperStore,
    client_id: &str,
    redirect_uri: &url::Url,
    scopes: &[String],
    patient: Option<&str>,
    now: DateTime<Utc>,
    registration: &RegistrationWrite,
) -> Result<(), GatekeeperError> {
    store.immediate_transaction(|tx| {
        if let RegistrationWrite::Widen { redirect_is_new } = *registration {
            let row = match tx.client_by_id(client_id)? {
                Some(existing) => {
                    widen_registration(existing, redirect_uri, scopes, redirect_is_new)
                }
                None => new_registration(client_id, redirect_uri, scopes, now),
            };
            // `upsert_client` updates in place, preserving `registered_at` and any
            // admin `disabled_at` — a widening never resurrects a disabled client.
            tx.upsert_client(&row)?;
        }
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

/// The `clients` row a first approval of an unregistered client creates: a
/// public client named after its own `client_id` (there is no registrar to have
/// supplied a display name), holding only the redirect it just used and the
/// scopes the Owner actually granted.
fn new_registration(
    client_id: &str,
    redirect_uri: &url::Url,
    granted_scopes: &[String],
    now: DateTime<Utc>,
) -> Client {
    Client {
        client_id: client_id.to_owned(),
        name: client_id.to_owned(),
        kind: ClientKind::Public,
        redirect_uris: vec![RegisteredRedirectUri::Absolute(redirect_uri.clone())],
        allowed_scopes: granted_scopes.to_vec(),
        allowed_grant_types: AllowedGrantType::ALL.to_vec(),
        secret_hash: None,
        registered_at: now,
        disabled_at: None,
    }
}

/// Widen an existing registration by what the Owner just approved: append the
/// `redirect_uri` as an absolute entry when it resolved to none of the existing
/// ones, and union the granted scopes into `allowed_scopes` — appending in
/// granted order, keeping the registered order, and never duplicating a string
/// already there. Everything else on the row (its name, kind, secret,
/// registration time) is left exactly as it was.
fn widen_registration(
    mut client: Client,
    redirect_uri: &url::Url,
    granted_scopes: &[String],
    redirect_is_new: bool,
) -> Client {
    if redirect_is_new {
        client
            .redirect_uris
            .push(RegisteredRedirectUri::Absolute(redirect_uri.clone()));
    }
    for granted in granted_scopes {
        if !client.allowed_scopes.contains(granted) {
            client.allowed_scopes.push(granted.clone());
        }
    }
    client
}

/// Approve an authorization-code consent prompt: judge the client's
/// registration, narrow the approved scopes to the grantable set, transition the
/// request, mint and persist the authorization code the polling endpoint hands
/// back, register-or-widen the client and refresh the standing grant, and return
/// the client callback URL. An approval that grants nothing is applied as a
/// **deny**.
///
/// Two authority checks stand between the Owner's click and a grant.
/// `ctx.approver` is the deciding Owner's granted scopes — the approval can't
/// delegate a resource scope the approver doesn't hold (see
/// [`ensure_approver_covers`]). And a
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
    publisher: &dyn DeviceUserCodePublisher,
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
    // The clamp: the registration alone for the first-party host, else the
    // registration widened by what this request asked for.
    let allowed: HashSet<&str> = if is_first_party {
        registered.into_iter().collect()
    } else {
        registered
            .into_iter()
            .chain(requested.iter().copied())
            .collect()
    };
    let granted_scopes = grantable_scopes(input.approved_scopes, &requested, &allowed);
    if granted_scopes.is_empty() {
        return deny_consent(store, publisher, id).map(|()| ConsentOutcome::Denied);
    }
    ensure_approver_covers(&granted_scopes, ctx.approver)?;

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
    upsert_authorization_code_grant(
        store,
        &request.client_id,
        &redirect_uri,
        &granted_scopes,
        input.patient.as_deref(),
        now,
        &registration_write,
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
