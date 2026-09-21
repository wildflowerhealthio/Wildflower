//! Authorization-code consent: load/approve/deny the code-flow prompt, and the
//! standing authorization-code grant — plus, for a client trusted on first use,
//! the `clients` row itself — that its approval upserts.

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use scopes_rust::{grantable_scopes, widened_scopes, Grant};
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
///
/// The scopes go in collapsed, through the same [`widened_scopes`] the widening
/// path uses (against an empty registration), so a row created by a first
/// approval and a row widened into the same state are byte-identical — the
/// approval order can't leave two clients with differently-spelled but
/// equivalent ceilings.
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
        allowed_scopes: widened_scopes(&[], granted_scopes),
        allowed_grant_types: AllowedGrantType::ALL.to_vec(),
        secret_hash: None,
        registered_at: now,
        disabled_at: None,
    }
}

/// Widen an existing registration by what the Owner just approved: append the
/// `redirect_uri` as an absolute entry when it resolved to none of the existing
/// ones, and widen `allowed_scopes` by the granted scopes. Everything else on
/// the row (its name, kind, secret, registration time) is left exactly as it
/// was.
///
/// The scope half is [`scopes_rust::widened_scopes`], not a string union: the
/// granted scopes are parsed, so an approval that grants
/// `patient/Patient.cruds` **replaces** a registered `patient/Patient.r`
/// instead of leaving the row carrying both, and granting again what the row
/// already covers leaves it untouched. `allowed_scopes` is only ever read
/// through [`scopes_rust::allowed_scope_covers`] (here, at `/authorize`, and in
/// [`classify_registration`](crate::domain::client_registration::classify_registration)),
/// so a collapsed row admits exactly the requests the un-collapsed one did.
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
    client.allowed_scopes = widened_scopes(&client.allowed_scopes, granted_scopes);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::client_registration::uncovered_scopes;
    use crate::domain::test_fake::client;

    fn redirect() -> url::Url {
        url::Url::parse("https://example.com/cb").expect("a valid redirect")
    }

    /// Widen the fixture client (registered with `registered`) by `granted`,
    /// leaving its redirect allowlist alone.
    fn widened(registered: &[&str], granted: &[&str]) -> Vec<String> {
        let granted: Vec<String> = granted.iter().map(|s| (*s).to_owned()).collect();
        widen_registration(client("app", registered), &redirect(), &granted, false).allowed_scopes
    }

    /// The registration records the *broader* grant rather than accumulating
    /// both spellings of the same resource.
    #[test]
    fn a_broader_grant_replaces_the_narrower_registered_scope() {
        assert_eq!(
            widened(&["patient/Patient.r", "openid"], &["patient/Patient.cruds"]),
            ["patient/Patient.cruds", "openid"]
        );
    }

    /// Two disjoint interactions on one resource are recorded as the single
    /// scope granting both, not as two rows.
    #[test]
    fn disjoint_interactions_on_one_resource_become_one_scope() {
        assert_eq!(
            widened(&["patient/Patient.r"], &["patient/Patient.s"]),
            ["patient/Patient.rs"]
        );
    }

    /// Re-approving what the row already covers leaves it byte-identical — the
    /// common case, where an app the Owner has approved before asks again.
    #[test]
    fn re_granting_a_covered_scope_leaves_the_row_untouched() {
        let registered = ["patient/*.cruds", "openid"];
        assert_eq!(
            widened(&registered, &["patient/Observation.r", "openid"]),
            registered
        );
    }

    /// A v1 word registration is never folded into a letter bag — that would
    /// hand the client letter-grammar access it was never registered for. The
    /// two spellings sit side by side until one genuinely covers the other.
    #[test]
    fn a_v1_word_registration_is_not_merged_into_letter_access() {
        assert_eq!(
            widened(&["patient/Patient.read"], &["patient/Patient.c"]),
            ["patient/Patient.read", "patient/Patient.c"]
        );
        assert_eq!(
            widened(&["patient/Patient.read"], &["patient/Patient.cruds"]),
            ["patient/Patient.cruds"]
        );
    }

    /// The property the trust-on-first-use path depends on: after widening, the
    /// same request classifies as fully covered — collapsing the row must never
    /// cost it coverage of what was just granted.
    #[test]
    fn everything_granted_is_covered_by_the_widened_row() {
        let granted = [
            "patient/Patient.r",
            "patient/Patient.s",
            "patient/Observation.read",
            "openid",
            "a_stray_unknown",
        ];
        let owned: Vec<String> = granted.iter().map(|s| (*s).to_owned()).collect();
        let widened = widened(&["patient/Condition.r"], &granted);
        assert!(uncovered_scopes(&widened, &owned).is_empty());
        // ...and the pre-existing registration survives it.
        assert!(uncovered_scopes(&widened, &["patient/Condition.r".to_owned()]).is_empty());
    }

    /// A row created by a first approval and a row widened into the same state
    /// agree exactly — `new_registration` and `widen_registration` share one
    /// collapse.
    #[test]
    fn a_new_registration_matches_a_row_widened_into_the_same_state() {
        let granted: Vec<String> = ["patient/Patient.r", "patient/Patient.s", "openid"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let fresh = new_registration("app", &redirect(), &granted, Utc::now());
        assert_eq!(fresh.allowed_scopes, ["patient/Patient.rs", "openid"]);
        assert_eq!(
            fresh.allowed_scopes,
            widened(&[], &["patient/Patient.r", "patient/Patient.s", "openid"])
        );
    }

    /// Widening the scopes never touches the redirect allowlist, and a new
    /// redirect is appended without disturbing the registered ones.
    #[test]
    fn the_redirect_allowlist_moves_only_when_the_redirect_is_new() {
        let registered = client("app", &["openid"]);
        let elsewhere = url::Url::parse("https://other.example/cb").unwrap();
        let granted = vec!["openid".to_owned()];

        let unchanged = widen_registration(registered.clone(), &elsewhere, &granted, false);
        assert_eq!(unchanged.redirect_uris, registered.redirect_uris);

        let appended = widen_registration(registered.clone(), &elsewhere, &granted, true);
        assert_eq!(
            appended.redirect_uris,
            [
                registered.redirect_uris[0].clone(),
                RegisteredRedirectUri::Absolute(elsewhere),
            ]
        );
    }
}
