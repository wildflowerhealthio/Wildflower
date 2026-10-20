//! [`DelegatedScopes`] — the proof that an approver (the Owner, or a browser
//! the Owner paired) may delegate a scope set to a client. No one can delegate
//! more than they hold. The scope rules the server leans on for that come in
//! three parts:
//!
//! - **What a prompt may grant at most**: each consent prompt has a ceiling,
//!   set by its flow and the client's registration ([`ApprovableScopes`]).
//!   Whatever the approver ticks is clamped to it.
//! - **What the approver must hold**: the prompt's **approval scopes** (the
//!   power to decide it and to create what approving it creates), and every
//!   piece of held access it passes on.
//! - **What the browser holds**: a code issued for a client carries only what
//!   the browser session the request was made in also holds
//!   ([`session_bounded_scopes`]), and the browser is told beforehand what it
//!   lacks ([`session_shortfall`]).
//!
//! Its one constructor, [`DelegatedScopes::clamp`], is the whole of the first
//! two parts.

use std::collections::HashSet;

use wildflowerhealthio_scopes::{grantable_scopes, render_scopes, Grant, Scope};

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::access::consents::{
    client_registering_approval_scopes, consent_decider_scopes, grant_creating_approval_scopes,
};
use crate::domain::client::Client;

/// The flow a consent prompt belongs to, which decides its ceiling, its
/// approval scopes, and whether approving it writes the client registration.
///
/// - A code prompt for a client trusted on first use records a grant, writes
///   the registration, and its approver must hold what is asked.
/// - A code prompt for a server-defined (fixed) registration records a grant
///   and its approver must hold what is asked, but it writes no registration.
/// - A device prompt records a grant only; its consent is expandable, so the
///   approver need not hold what the device asked for.
/// - A browser pairing records no grant and writes no registration; like a
///   device prompt it is expandable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ApprovalFlow {
    /// An authorization-code prompt, whose approval records a standing grant
    /// and approves the request as asked.
    Code {
        /// Whether the client's registration is server-defined, which an
        /// approval never writes. When it is not, the client is trusted on
        /// first use, so approving creates or widens its registration.
        registration_is_fixed: bool,
    },
    /// A device-code prompt: approving records a standing device grant.
    Device,
    /// A browser pairing: approving records no grant and registers no client.
    BrowserPairing,
}

impl ApprovalFlow {
    /// Whether approving records a standing grant: a code or device approval.
    fn would_record_grant(self) -> bool {
        self != ApprovalFlow::BrowserPairing
    }

    /// Whether approving creates or widens the client's registration: a code
    /// approval for a client trusted on first use.
    fn would_write_registration(self) -> bool {
        self == ApprovalFlow::Code {
            registration_is_fixed: false,
        }
    }

    /// Whether the approver must hold every resource scope the request asks
    /// for: a code approval, which approves the request as asked. Device and
    /// pairing consent is expandable instead.
    fn would_approve_as_asked(self) -> bool {
        matches!(self, ApprovalFlow::Code { .. })
    }
}

/// The scopes one consent prompt may grant at most, decided by its flow. An
/// approved scope must be covered by a scope of the request **and** by a
/// scope of the registration ceiling (the most the client's registration
/// permits for this approval); each constructor names the policy that fills
/// those two halves.
///
/// The flow also decides the prompt's **approval scopes**, what its approver
/// must hold to approve it at all
/// ([`missing_approval_scopes`](Self::missing_approval_scopes)).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ApprovableScopes {
    /// The half that bounds a tick by what was asked: the request's scopes for
    /// a code prompt, so a code prompt never grants past what the client asked
    /// for. An expandable prompt fills it with its ceiling instead: a device
    /// prompt's registered scopes, a pairing's the Owner's scopes.
    requested_scopes: Vec<String>,
    /// The most the client's registration permits for this approval: a fixed
    /// registration's scopes, a registration trusted on first use's scopes
    /// plus what the request asks for, a device client's registered scopes, or
    /// the Owner's scopes for a pairing.
    registration_ceiling_scopes: Vec<String>,
    /// The prompt's flow, which sets its approval scopes and whether approving
    /// it writes the registration.
    flow: ApprovalFlow,
}

impl ApprovableScopes {
    /// A device-code prompt for a client registered with
    /// `registered_client_scopes`. Device consent is **expandable**: the Owner
    /// may grant anything the client's registration allows, whatever the
    /// device asked for, so the registered client scopes fill both halves.
    pub(crate) fn for_device(registered_client_scopes: &[String]) -> Self {
        ApprovableScopes {
            requested_scopes: registered_client_scopes.to_vec(),
            registration_ceiling_scopes: registered_client_scopes.to_vec(),
            flow: ApprovalFlow::Device,
        }
    }

    /// A browser pairing prompt. It requests the Owner's scopes, and like
    /// device consent it is **expandable**: the Owner may grant anything up to
    /// [`OWNER_SCOPES`](crate::OWNER_SCOPES), which fill both halves, so no
    /// paired browser session can hold more than a same-device session.
    pub(crate) fn for_browser_pairing() -> Self {
        ApprovableScopes {
            requested_scopes: crate::owner_scopes(),
            registration_ceiling_scopes: crate::owner_scopes(),
            flow: ApprovalFlow::BrowserPairing,
        }
    }

    /// An authorization-code prompt for `requested_scopes`. A fixed
    /// (server-defined) registration is its own ceiling; any other client
    /// is trusted on first use, so its ceiling also takes in what this request
    /// asked for — its registration is widened with the grant.
    pub(crate) fn for_code(
        requested_scopes: &[String],
        maybe_existing_client: Option<&Client>,
        registration_is_fixed: bool,
    ) -> Self {
        let registered_client_scopes = maybe_existing_client
            .iter()
            .flat_map(|existing_client| existing_client.allowed_scopes.iter().cloned());
        let registration_ceiling_scopes = if registration_is_fixed {
            registered_client_scopes.collect()
        } else {
            registered_client_scopes
                .chain(requested_scopes.iter().cloned())
                .collect()
        };
        ApprovableScopes {
            requested_scopes: requested_scopes.to_vec(),
            registration_ceiling_scopes,
            flow: ApprovalFlow::Code {
                registration_is_fixed,
            },
        }
    }

    /// The subset of the `owner_approved_scopes` (the approver's ticks) this
    /// prompt may grant: each one covered by a requested scope and by a
    /// registration-ceiling scope (by permission, not spelling — see
    /// [`wildflowerhealthio_scopes::grantable_scopes`]). Rendered in canonical
    /// form, deduplicated, in the order the approver gave them.
    pub(crate) fn grantable_subset(&self, owner_approved_scopes: Vec<String>) -> Vec<String> {
        let requested: HashSet<&str> = self.requested_scopes.iter().map(String::as_str).collect();
        let ceiling: HashSet<&str> = self
            .registration_ceiling_scopes
            .iter()
            .map(String::as_str)
            .collect();
        grantable_scopes(owner_approved_scopes, &requested, &ceiling)
    }

    /// Everything the approver holding `approver_grant` may delegate on this
    /// prompt, which the pairing card's ticks start from: each requested scope and
    /// each of the approver's own scopes the prompt may grant, less any held
    /// access ([`is_held_access`]) the approver does not cover. Approving it
    /// untouched passes [`DelegatedScopes::clamp`]'s approver check, so a
    /// pairing card that starts from the Owner's scopes starts an approver
    /// holding less from all it holds instead.
    pub(crate) fn delegable_scopes(&self, approver_grant: &Grant) -> Vec<String> {
        let candidates = self
            .requested_scopes
            .iter()
            .cloned()
            .chain(approver_grant.render())
            .collect();
        let approver_may_pass_on = may_pass_on(approver_grant);
        self.grantable_subset(candidates)
            .into_iter()
            .filter(|rendered| approver_may_pass_on(&Scope::from(rendered.as_str())))
            .collect()
    }

    /// The prompt's **approval scopes** the `approver_grant` does not cover,
    /// rendered, in order; empty when it may approve. Shared by the approve
    /// paths (through [`DelegatedScopes::clamp`]), the consent read
    /// (`missingApprovalScopes`), and `/oauth/authorize`'s choice between the
    /// consent card and the wait page, so the three never disagree.
    ///
    /// The approval scopes, and who takes them:
    ///
    /// - `wildflower/AuthorizationRequest.u`: every approval, to decide the
    ///   request at all.
    /// - `wildflower/Grant.c`: a code or device approval, which records a
    ///   standing grant; a browser pairing records none.
    /// - `wildflower/Client.c` and `wildflower/Client.u`: a code approval for
    ///   a client trusted on first use, which creates or widens its
    ///   registration, whichever the row needs when the approval lands; a
    ///   server-defined registration takes neither.
    /// - Each held access ([`is_held_access`]) the request asks for that the
    ///   prompt may grant: a code approval, which approves the request as
    ///   asked, else it goes to the Owner.
    ///
    /// A device or pairing prompt is expandable, so its approver may grant
    /// whatever it holds, and [`DelegatedScopes::clamp`] bounds that scope by
    /// scope instead. The Owner's scopes lack no approval scope on any prompt.
    pub(crate) fn missing_approval_scopes(&self, approver_grant: &Grant) -> Vec<String> {
        let mut approval_scopes = consent_decider_scopes();
        if self.flow.would_record_grant() {
            approval_scopes.extend(grant_creating_approval_scopes());
        }
        if self.flow.would_write_registration() {
            approval_scopes.extend(client_registering_approval_scopes());
        }
        let uncovered_approval_scopes: Vec<Scope> = approval_scopes
            .into_iter()
            .filter(|required| !approver_grant.covers(required))
            .collect();
        let mut missing = render_scopes(&uncovered_approval_scopes);
        if self.flow.would_approve_as_asked() {
            missing.extend(uncovered_held_access(
                &self.grantable_subset(self.requested_scopes.clone()),
                approver_grant,
            ));
        }
        missing
    }
}

/// A scope set an approver has approved **and** is entitled to delegate. Holding
/// one is proof that the approver held the prompt's approval scopes, and that
/// every held access ([`is_held_access`]) in it is covered by the approver's
/// own grant, so the writers that record grants, write registrations, and
/// issue codes accept nothing else. The fields are private and there is no
/// other constructor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DelegatedScopes {
    /// The ticks that survived the prompt's ceiling, every held access among
    /// them covered by the approver: what the request's approval, the standing
    /// grant and a widened registration record as they are. A code issued
    /// under them is further bounded by the browser session.
    scopes: Vec<String>,
    /// Whether the approval behind the proof creates or widens the client's
    /// registration: only a code approval for a client trusted on first use,
    /// whose approver held `wildflower/Client.c` and `wildflower/Client.u`.
    /// The grant recorder asks it whether to write the `clients` row.
    writes_registration: bool,
}

impl DelegatedScopes {
    /// The approval rule, in three steps:
    ///
    /// 1. Require that the `approver_grant` holds the `approvable` prompt's
    ///    approval scopes
    ///    ([`missing_approval_scopes`](ApprovableScopes::missing_approval_scopes)),
    ///    whatever was ticked, even nothing.
    /// 2. Clamp the `owner_approved_scopes` to the `approvable` scopes'
    ///    grantable subset: `Ok(None)` when nothing survives, and the caller
    ///    denies rather than recording an empty grant.
    /// 3. Require that the `approver_grant` covers every held access
    ///    ([`is_held_access`]) that survives, in either spelling; one it lacks
    ///    fails the whole approval, naming it.
    ///
    /// Identity and session
    /// markers (`openid`, `offline_access`, …) are no held access and pass the
    /// approver check; a resource scope or `wildflower/launch` the approver
    /// lacks fails the whole approval (a `403`) rather than being silently
    /// dropped. Coverage is checked across both SMART spellings via
    /// [`Scope::as_alternate_canonical_form`], the twinning the token minter
    /// applies.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::InsufficientScope`] naming the approval
    /// scopes the approver lacks, checked first, whatever was ticked; then
    /// [`AuthorizationServerError::InsufficientApproverScope`] naming the
    /// held access the approver cannot delegate.
    pub(crate) fn clamp(
        approver_grant: &Grant,
        owner_approved_scopes: Vec<String>,
        approvable: &ApprovableScopes,
    ) -> Result<Option<Self>, AuthorizationServerError> {
        let missing_scopes = approvable.missing_approval_scopes(approver_grant);
        if !missing_scopes.is_empty() {
            return Err(AuthorizationServerError::InsufficientScope { missing_scopes });
        }
        let grantable = approvable.grantable_subset(owner_approved_scopes);
        if grantable.is_empty() {
            return Ok(None);
        }
        let approver_missing_scopes = uncovered_held_access(&grantable, approver_grant);
        if approver_missing_scopes.is_empty() {
            Ok(Some(DelegatedScopes {
                scopes: grantable,
                writes_registration: approvable.flow.would_write_registration(),
            }))
        } else {
            Err(AuthorizationServerError::InsufficientApproverScope {
                approver_missing_scopes,
            })
        }
    }

    /// The delegated scopes, rendered — the set every write under this proof
    /// records verbatim.
    pub(crate) fn scopes(&self) -> &[String] {
        &self.scopes
    }

    /// Whether the approval behind this proof creates or widens its client's
    /// registration (a code approval for a client trusted on first use, whose
    /// approver held `wildflower/Client.c` and `wildflower/Client.u`).
    pub(crate) fn would_write_registration(&self) -> bool {
        self.writes_registration
    }
}

/// Whether `scope` is access its holder must itself hold to pass on: a
/// resource scope, or `wildflower/launch`. An approver delegates, and a
/// browser session bounds a code to, only the held access it covers. Identity
/// and session markers (`openid`, `fhirUser`, `launch`, `offline_access`, …)
/// are no access anyone holds, so anyone may pass them on.
fn is_held_access(scope: &Scope) -> bool {
    scope.is_resource() || *scope == Scope::any_scoped_app_launch()
}

/// Whether `holder` may pass a scope on: it is no held access
/// ([`is_held_access`]), or `holder` covers it in either SMART spelling.
fn may_pass_on(holder: &Grant) -> impl Fn(&Scope) -> bool {
    let holder_covers = coverage_in_either_spelling(holder);
    move |scope: &Scope| !is_held_access(scope) || holder_covers(scope)
}

/// The held access in `granted` the `holder` may not pass on
/// ([`may_pass_on`]), rendered, in order.
fn uncovered_held_access(granted: &[String], holder: &Grant) -> Vec<String> {
    let holder_may_pass_on = may_pass_on(holder);
    granted
        .iter()
        .filter(|rendered| !holder_may_pass_on(&Scope::from(rendered.as_str())))
        .cloned()
        .collect()
}

/// The `authorized` scopes narrowed to what the browser session holding
/// `session_grant` also holds: an authorization code carries only what both
/// the client's authority and the browser the request was made in allow.
///
/// Held access ([`is_held_access`]) the session covers, by the rule
/// [`DelegatedScopes::clamp`] holds an approver to (either SMART spelling,
/// `system/*` covering `patient/*` and `user/*`), stays as authorized. Held
/// access the session covers only in part narrows to the parts it holds: its
/// intersection with each session scope
/// ([`intersection_in_either_spelling`]), so `system/*.cruds` against a
/// session holding `system/Patient.cruds` yields `system/Patient.cruds`. A
/// part is spelled in the authorized scope's grammar where one spells it, and
/// in letters where no word does.
/// `wildflower/launch` has no parts, so it stays only when the session holds
/// it. Identity and session markers are no held access, so they pass through.
///
/// One scope's parts are collapsed ([`Grant::collapse`]), so overlapping
/// session scopes yield the broadest part once, and the result keeps each
/// scope's first occurrence, in order. A session that covers everything
/// authorized changes nothing but exact duplicates.
pub(crate) fn session_bounded_scopes(authorized: &[String], session_grant: &Grant) -> Vec<String> {
    let session_covers = coverage_in_either_spelling(session_grant);
    let mut already_bounded = HashSet::new();
    let bounded: Vec<Scope> = authorized
        .iter()
        .map(|rendered| Scope::from(rendered.as_str()))
        .flat_map(|authorized_scope| {
            if !is_held_access(&authorized_scope) || session_covers(&authorized_scope) {
                vec![authorized_scope]
            } else {
                let mut parts = Grant::new(
                    session_grant
                        .scopes
                        .iter()
                        .filter_map(|session_scope| {
                            intersection_in_either_spelling(&authorized_scope, session_scope)
                        })
                        .collect(),
                );
                parts.collapse();
                parts.scopes
            }
        })
        .filter(|scope| already_bounded.insert(scope.clone()))
        .collect();
    render_scopes(&bounded)
}

/// The broadest scope both `authorized_scope` and `session_scope` cover
/// ([`Scope::intersection`]) when each also counts in its alternate canonical
/// form, spelled in the authorized scope's grammar where one exists:
/// `patient/Observation.rs` against `patient/Observation.read` is
/// `patient/Observation.rs`, and `patient/*.read` against `patient/Patient.rs`
/// is `patient/Patient.read`. `patient/*.read` against `patient/Patient.r` has
/// no word spelling, so it is the letter `patient/Patient.r`.
fn intersection_in_either_spelling(
    authorized_scope: &Scope,
    session_scope: &Scope,
) -> Option<Scope> {
    let authorized_spellings = [
        Some(authorized_scope.clone()),
        authorized_scope.as_alternate_canonical_form(),
    ];
    // The session's letter form first, so a letter-spelled authorized scope
    // intersects to a letter bag rather than the session's word.
    let session_spellings = [
        session_scope.as_alternate_canonical_form(),
        Some(session_scope.clone()),
    ];
    authorized_spellings
        .iter()
        .flatten()
        .find_map(|authorized_spelling| {
            session_spellings
                .iter()
                .flatten()
                .find_map(|session_spelling| authorized_spelling.intersection(session_spelling))
        })
}

/// What a code issued in the browser session holding `session_grant` would
/// not carry of the `requested` scopes, in the request's order: for each held
/// access ([`is_held_access`]) the session does not cover, the part of it the
/// session lacks ([`Grant::uncovered_part`], in either SMART spelling), whether
/// [`session_bounded_scopes`] drops the scope or narrows it to the part the
/// session holds. A session holding `system/*.cuds` and `system/Patient.r`
/// lacks `system/MedicationRequest.r` of `system/MedicationRequest.rs`, and
/// nothing of `system/Patient.rs`. Empty when the session holds all the
/// request asks for.
pub(crate) fn session_shortfall(requested: &[String], session_grant: &Grant) -> Vec<String> {
    let session_lacks = uncovered_part_in_either_spelling(session_grant);
    let lacking: Vec<Scope> = requested
        .iter()
        .map(|rendered| Scope::from(rendered.as_str()))
        .filter(is_held_access)
        .filter_map(|requested_scope| session_lacks(&requested_scope))
        .collect();
    render_scopes(&lacking)
}

/// Whether `holder` covers a scope in either SMART spelling: nothing of it is
/// left uncovered ([`uncovered_part_in_either_spelling`]).
fn coverage_in_either_spelling(holder: &Grant) -> impl Fn(&Scope) -> bool {
    let holder_lacks = uncovered_part_in_either_spelling(holder);
    move |scope: &Scope| holder_lacks(scope).is_none()
}

/// The part of a scope `holder`'s scopes do not cover between them
/// ([`Grant::uncovered_part`]), each held scope also counting in its alternate
/// canonical form, or `None` when they cover all of it. With every held word
/// also counted as its letters, a held scope covers an asked scope in either
/// of the asked scope's spellings alike, so the asked scope needs no twin.
fn uncovered_part_in_either_spelling(holder: &Grant) -> impl Fn(&Scope) -> Option<Scope> {
    let authority = Grant::new(
        holder
            .scopes
            .iter()
            .flat_map(|held| [Some(held.clone()), held.as_alternate_canonical_form()])
            .flatten()
            .collect(),
    );
    move |scope: &Scope| authority.uncovered_part(scope)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::{client, owned_scopes};

    /// A prompt for a fixed registration: exactly what `requested` asks
    /// within what `allowed` lists.
    fn approvable(requested: &[&str], allowed: &[&str]) -> ApprovableScopes {
        ApprovableScopes::for_code(
            &owned_scopes(requested),
            Some(&client("app", allowed)),
            true,
        )
    }

    /// An approver's grant: the approval scopes of a prompt that registers no
    /// client (it decides requests and creates grants), plus `scopes`.
    fn grant(scopes: &[&str]) -> Grant {
        Grant::parse(
            ["wildflower/AuthorizationRequest.u", "wildflower/Grant.c"]
                .iter()
                .chain(scopes)
                .copied(),
        )
    }

    /// A device prompt for a client allowed `allowed`: expandable, so its
    /// approver delegates within what it holds, scope by scope.
    fn device_prompt(allowed: &[&str]) -> ApprovableScopes {
        ApprovableScopes::for_device(&owned_scopes(allowed))
    }

    /// The happy path: ticks inside the approvable scopes and inside the
    /// approver's own authority come back as the delegated set, verbatim.
    #[test]
    fn clamp_admits_covered_approvable_scopes() {
        let requested: &[&str] = &["patient/Patient.r", "openid"];
        let allowed: &[&str] = &["patient/Patient.r", "openid", "patient/Observation.r"];
        let delegated = DelegatedScopes::clamp(
            &grant(&["system/*.cruds"]),
            owned_scopes(&["patient/Patient.r", "openid"]),
            &approvable(requested, allowed),
        )
        .expect("approver covers everything")
        .expect("something was granted");
        assert_eq!(delegated.scopes(), ["patient/Patient.r", "openid"]);
    }

    /// A tick outside the approvable scopes (requested ∩ allowed) is dropped,
    /// not delegated.
    #[test]
    fn clamp_drops_ticks_outside_the_approvable_scopes() {
        let requested: &[&str] = &["patient/Patient.r"];
        let allowed: &[&str] = &["patient/Patient.r"];
        let delegated = DelegatedScopes::clamp(
            &grant(&["system/*.cruds"]),
            owned_scopes(&["patient/Patient.r", "patient/Observation.r"]),
            &approvable(requested, allowed),
        )
        .expect("approver covers everything")
        .expect("something was granted");
        assert_eq!(delegated.scopes(), ["patient/Patient.r"]);
    }

    /// Nothing surviving the clamp is `None`, so the caller denies rather than
    /// recording an empty grant.
    #[test]
    fn clamp_yields_none_when_nothing_survives() {
        let requested: &[&str] = &["patient/Patient.r"];
        let allowed: &[&str] = &["patient/Patient.r"];
        let delegated = DelegatedScopes::clamp(
            &grant(&["system/*.cruds"]),
            owned_scopes(&["patient/Observation.r"]),
            &approvable(requested, allowed),
        )
        .expect("no approver check runs on an empty set");
        assert_eq!(delegated, None);
    }

    /// The escalation the proof exists to rule out: a resource scope the approver
    /// does not hold fails the approval and names the scope, rather than being
    /// delegated or silently narrowed.
    #[test]
    fn clamp_rejects_a_resource_scope_the_approver_does_not_hold() {
        let outcome = DelegatedScopes::clamp(
            &grant(&["patient/Patient.r"]),
            owned_scopes(&["patient/Patient.r", "patient/Observation.r"]),
            &device_prompt(&["patient/Patient.r", "patient/Observation.r"]),
        );
        assert_eq!(
            outcome,
            Err(AuthorizationServerError::InsufficientApproverScope {
                approver_missing_scopes: owned_scopes(&["patient/Observation.r"]),
            }),
        );
    }

    /// An approver holding nothing at all can delegate no resource scope — the
    /// "gain scope from nothing" case.
    #[test]
    fn clamp_rejects_every_resource_scope_for_an_empty_approver() {
        let outcome = DelegatedScopes::clamp(
            &grant(&[]),
            owned_scopes(&["patient/Patient.r"]),
            &device_prompt(&["patient/Patient.r"]),
        );
        assert!(matches!(
            outcome,
            Err(AuthorizationServerError::InsufficientApproverScope { .. })
        ));
    }

    /// Identity and session markers are not resource access, so an approver who
    /// holds none of them may still delegate them.
    #[test]
    fn clamp_passes_identity_markers_through_the_approver_check() {
        let requested: &[&str] = &["openid", "offline_access"];
        let allowed = requested;
        let delegated = DelegatedScopes::clamp(
            &grant(&["patient/Patient.r"]),
            owned_scopes(&["openid", "offline_access"]),
            &approvable(requested, allowed),
        )
        .expect("markers need no resource authority")
        .expect("granted");
        assert_eq!(delegated.scopes().len(), 2);
    }

    /// The v1-word / v2-letter bridge: an approver holding the letter form covers
    /// a delegation spelled in the word form, and vice versa.
    #[test]
    fn clamp_covers_across_the_two_smart_spellings() {
        let requested: &[&str] = &["patient/Patient.read"];
        let allowed = requested;
        let delegated = DelegatedScopes::clamp(
            &grant(&["patient/Patient.rs"]),
            owned_scopes(&["patient/Patient.read"]),
            &approvable(requested, allowed),
        )
        .expect("letter authority covers the word spelling")
        .expect("granted");
        assert_eq!(delegated.scopes(), ["patient/Patient.read"]);
    }

    /// Device consent is expandable: anything the client is allowed is
    /// grantable, whatever the device asked for, and nothing beyond it.
    #[test]
    fn a_device_prompt_grants_within_the_client_allowance() {
        let approvable =
            ApprovableScopes::for_device(&owned_scopes(&["patient/*.rs", "offline_access"]));
        assert_eq!(
            approvable.grantable_subset(owned_scopes(&[
                "patient/Observation.r",
                "offline_access",
                "system/*.r",
            ])),
            ["patient/Observation.r", "offline_access"],
        );
    }

    /// A client trusted on first use may be granted what its request asked
    /// for even when its registration does not list it (or it has none yet);
    /// a fixed registration may not.
    #[test]
    fn a_code_prompt_widens_the_allowance_only_for_a_registration_trusted_on_first_use() {
        let requested = owned_scopes(&["patient/Patient.r", "openid"]);
        let registered = client("app", &["openid"]);
        let approved = || owned_scopes(&["patient/Patient.r", "openid"]);

        let trusted_on_first_use = ApprovableScopes::for_code(&requested, Some(&registered), false);
        assert_eq!(
            trusted_on_first_use.grantable_subset(approved()),
            ["patient/Patient.r", "openid"]
        );
        let unknown = ApprovableScopes::for_code(&requested, None, false);
        assert_eq!(
            unknown.grantable_subset(approved()),
            ["patient/Patient.r", "openid"]
        );

        let fixed = ApprovableScopes::for_code(&requested, Some(&registered), true);
        assert_eq!(fixed.grantable_subset(approved()), ["openid"]);
    }

    /// Even for a registration trusted on first use, a code prompt never grants past what
    /// the request asked for.
    #[test]
    fn a_code_prompt_never_grants_beyond_the_request() {
        let approvable = ApprovableScopes::for_code(
            &owned_scopes(&["openid"]),
            Some(&client("app", &["openid", "patient/Patient.r"])),
            false,
        );
        assert_eq!(
            approvable.grantable_subset(owned_scopes(&["openid", "patient/Patient.r"])),
            ["openid"],
        );
    }

    /// A pairing prompt grants up to the Owner's scopes, whatever the ticks
    /// started from, and never past them: a tick no Owner scope covers is
    /// dropped.
    #[test]
    fn a_pairing_prompt_grants_up_to_the_owner_s_scopes() {
        let approvable = ApprovableScopes::for_browser_pairing();
        assert_eq!(
            approvable.grantable_subset(owned_scopes(&[
                "wildflower/launch",
                "system/Patient.rs",
                "openid",
                "offline_access",
            ])),
            ["wildflower/launch", "system/Patient.rs"],
        );
    }

    /// The approval scopes follow the flow: deciding always, creating the
    /// grant for a code or device approval, and both client scopes for a code
    /// approval that writes a registration trusted on first use, however the
    /// row stands.
    #[test]
    fn the_approval_scopes_follow_the_flow() {
        let nothing = Grant::parse(Vec::<&str>::new());
        let registered = client("app", &["openid"]);
        for (approvable, expected) in [
            (
                ApprovableScopes::for_browser_pairing(),
                &["wildflower/AuthorizationRequest.u"][..],
            ),
            (
                device_prompt(&["openid"]),
                &["wildflower/AuthorizationRequest.u", "wildflower/Grant.c"][..],
            ),
            (
                ApprovableScopes::for_code(&owned_scopes(&["openid"]), Some(&registered), true),
                &["wildflower/AuthorizationRequest.u", "wildflower/Grant.c"][..],
            ),
            (
                ApprovableScopes::for_code(&owned_scopes(&["openid"]), Some(&registered), false),
                &[
                    "wildflower/AuthorizationRequest.u",
                    "wildflower/Grant.c",
                    "wildflower/Client.c",
                    "wildflower/Client.u",
                ][..],
            ),
            (
                ApprovableScopes::for_code(&owned_scopes(&["openid"]), None, false),
                &[
                    "wildflower/AuthorizationRequest.u",
                    "wildflower/Grant.c",
                    "wildflower/Client.c",
                    "wildflower/Client.u",
                ][..],
            ),
        ] {
            assert_eq!(
                approvable.missing_approval_scopes(&nothing),
                expected,
                "{approvable:?}"
            );
        }
    }

    /// A code approval also takes every resource scope the prompt may grant,
    /// in either SMART spelling: the approver approves the request as asked or
    /// leaves it to the Owner. The fixed registration's ceiling drops what it
    /// can't grant first.
    #[test]
    fn a_code_approval_takes_the_requested_resource_scopes() {
        let requested = owned_scopes(&["patient/Observation.read", "system/Patient.r", "openid"]);
        let fixed = ApprovableScopes::for_code(
            &requested,
            Some(&client("app", &["patient/Observation.read", "openid"])),
            true,
        );
        assert_eq!(
            fixed.missing_approval_scopes(&grant(&[])),
            ["patient/Observation.read"]
        );
        assert_eq!(
            fixed.missing_approval_scopes(&grant(&["patient/Observation.rs"])),
            Vec::<String>::new()
        );
        let trusted_on_first_use = ApprovableScopes::for_code(&requested, None, false);
        assert_eq!(
            trusted_on_first_use.missing_approval_scopes(&grant(&[
                "wildflower/Client.cu",
                "patient/Observation.rs"
            ])),
            ["system/Patient.r"]
        );
    }

    /// A pairing prompt's delegable scopes are the Owner's for the Owner, and
    /// everything a narrower approver holds that an Owner could grant (its
    /// `openid` is no Owner scope), so approving them passes the clamp.
    #[test]
    fn a_pairing_prompt_s_delegable_scopes_are_what_the_approver_holds() {
        let approvable = ApprovableScopes::for_browser_pairing();
        assert_eq!(
            approvable.delegable_scopes(&Grant::parse(crate::owner_scopes())),
            crate::owner_scopes(),
        );
        let narrower = grant(&["system/Patient.rs", "wildflower/launch", "openid"]);
        let delegable = approvable.delegable_scopes(&narrower);
        assert_eq!(
            delegable,
            [
                "wildflower/launch",
                "wildflower/AuthorizationRequest.u",
                "wildflower/Grant.c",
                "system/Patient.rs",
            ],
        );
        assert_eq!(
            DelegatedScopes::clamp(&narrower, delegable.clone(), &approvable)
                .expect("the approver covers what it may delegate")
                .expect("granted")
                .scopes(),
            delegable,
        );
    }

    /// `wildflower/launch` is held access like a resource scope: a pairing
    /// card for an approver without it opens without it ticked, and ticking
    /// it anyway fails the approver check rather than handing the new session
    /// a launch its approver lacks.
    #[test]
    fn an_approver_without_launch_may_not_delegate_it() {
        let approvable = ApprovableScopes::for_browser_pairing();
        let without_launch = grant(&["system/Patient.rs"]);
        assert_eq!(
            approvable.delegable_scopes(&without_launch),
            [
                "wildflower/AuthorizationRequest.u",
                "wildflower/Grant.c",
                "system/Patient.rs",
            ],
        );
        assert_eq!(
            DelegatedScopes::clamp(
                &without_launch,
                owned_scopes(&["wildflower/launch", "system/Patient.rs"]),
                &approvable,
            ),
            Err(AuthorizationServerError::InsufficientApproverScope {
                approver_missing_scopes: owned_scopes(&["wildflower/launch"]),
            }),
        );
    }

    /// The Owner's scopes cover every approval scope of every flow, whatever
    /// a code request asks for.
    #[test]
    fn the_owner_s_scopes_cover_every_approval_scope() {
        let owner_grant = Grant::parse(crate::owner_scopes());
        let requested = owned_scopes(&["user/*.cruds", "patient/Observation.read", "openid"]);
        for approvable in [
            ApprovableScopes::for_browser_pairing(),
            device_prompt(&["openid"]),
            ApprovableScopes::for_code(&requested, None, false),
            ApprovableScopes::for_code(&requested, Some(&client("app", &["openid"])), false),
        ] {
            assert_eq!(
                approvable.missing_approval_scopes(&owner_grant),
                Vec::<String>::new(),
                "{approvable:?}"
            );
        }
    }

    /// An approver lacking an approval scope is refused whatever it ticked,
    /// even nothing, rather than having the approval applied as a deny.
    #[test]
    fn clamp_refuses_an_approver_lacking_an_approval_scope_before_anything_else() {
        let outcome = DelegatedScopes::clamp(
            &Grant::parse(["wildflower/AuthorizationRequest.u", "system/*.cruds"]),
            Vec::new(),
            &device_prompt(&["system/Patient.r"]),
        );
        assert_eq!(
            outcome,
            Err(AuthorizationServerError::InsufficientScope {
                missing_scopes: owned_scopes(&["wildflower/Grant.c"]),
            }),
        );
    }

    /// A session bounds a code's resource scopes by coverage in either SMART
    /// spelling: the letter form covers the word form and back, and `system/*`
    /// covers `patient/*` and `user/*`. What it holds none of is dropped.
    #[test]
    fn a_session_bounds_resource_scopes_by_coverage_in_either_spelling() {
        assert_eq!(
            session_bounded_scopes(
                &owned_scopes(&[
                    "patient/Patient.read",
                    "patient/Observation.rs",
                    "patient/Condition.rs",
                    "wildflower/Grant.c",
                ]),
                &Grant::parse(["patient/Patient.rs", "patient/Observation.read"]),
            ),
            ["patient/Patient.read", "patient/Observation.rs"],
        );
        assert_eq!(
            session_bounded_scopes(
                &owned_scopes(&[
                    "patient/Observation.rs",
                    "user/*.cruds",
                    "wildflower/Grant.c"
                ]),
                &Grant::parse(["system/*.cruds"]),
            ),
            ["patient/Observation.rs", "user/*.cruds"],
        );
    }

    /// A scope the session holds only part of narrows to the parts it holds:
    /// wildcards to the session's named types, contexts to the session's, and
    /// interactions to those the session holds.
    #[test]
    fn a_session_narrows_a_scope_it_holds_only_part_of() {
        let paired_session = Grant::parse([
            "wildflower/launch",
            "system/Patient.cruds",
            "system/Observation.rs",
            "wildflower/Apps.r",
        ]);
        assert_eq!(
            session_bounded_scopes(
                &owned_scopes(&["system/*.cruds", "wildflower/*.cruds", "openid"]),
                &paired_session,
            ),
            [
                "system/Patient.cruds",
                "system/Observation.rs",
                "wildflower/Apps.r",
                "openid",
            ],
        );
        let patient_session = Grant::parse(["patient/Patient.rs", "patient/Observation.r"]);
        assert_eq!(
            session_bounded_scopes(&owned_scopes(&["patient/*.rs"]), &patient_session),
            ["patient/Patient.rs", "patient/Observation.r"],
        );
        // A word scope narrows in its own grammar where a word spells the
        // part, and to the letter form where none does.
        assert_eq!(
            session_bounded_scopes(&owned_scopes(&["patient/*.read"]), &patient_session),
            ["patient/Patient.read", "patient/Observation.r"],
        );
        assert_eq!(
            session_bounded_scopes(
                &owned_scopes(&["patient/Observation.rs"]),
                &Grant::parse(["patient/Observation.r"]),
            ),
            ["patient/Observation.r"],
        );
        // A letter scope stays letters against a session spelled in words.
        assert_eq!(
            session_bounded_scopes(
                &owned_scopes(&["patient/*.cruds"]),
                &Grant::parse(["patient/Observation.read"]),
            ),
            ["patient/Observation.rs"],
        );
    }

    /// Parts the session holds several ways come out once: one scope's
    /// overlapping parts collapse into the broadest, and a part two scopes
    /// share appears once.
    #[test]
    fn a_session_s_parts_are_deduplicated() {
        assert_eq!(
            session_bounded_scopes(
                &owned_scopes(&["system/*.cruds"]),
                &Grant::parse(["system/*.rs", "system/Patient.r", "patient/*.rs"]),
            ),
            ["system/*.rs"],
        );
        assert_eq!(
            session_bounded_scopes(
                &owned_scopes(&["system/*.cruds", "patient/*.rs", "openid", "openid"]),
                &Grant::parse(["patient/Patient.r"]),
            ),
            ["patient/Patient.r", "openid"],
        );
    }

    /// Identity and session markers pass through a session that holds none of
    /// them; `wildflower/launch` stays only when the session holds it.
    #[test]
    fn a_session_passes_markers_through_and_bounds_launch() {
        let authorized = owned_scopes(&[
            "openid",
            "fhirUser",
            "launch",
            "launch/patient",
            "offline_access",
            "wildflower/launch",
            "patient/Patient.rs",
        ]);
        assert_eq!(
            session_bounded_scopes(&authorized, &Grant::parse(["patient/Observation.r"])),
            [
                "openid",
                "fhirUser",
                "launch",
                "launch/patient",
                "offline_access"
            ],
        );
        assert_eq!(
            session_bounded_scopes(&authorized, &Grant::parse(["wildflower/launch"])),
            [
                "openid",
                "fhirUser",
                "launch",
                "launch/patient",
                "offline_access",
                "wildflower/launch"
            ],
        );
    }

    /// The Owner's scopes bound nothing an approval can grant.
    #[test]
    fn the_owner_s_session_bounds_nothing() {
        let authorized = owned_scopes(&[
            "patient/Observation.read",
            "user/*.cruds",
            "wildflower/Apps.r",
            "wildflower/launch",
            "openid",
        ]);
        assert_eq!(
            session_bounded_scopes(&authorized, &Grant::parse(crate::owner_scopes())),
            authorized,
        );
    }

    /// The shortfall is what the session lacks of every requested scope the
    /// session bound drops or narrows, in the request's order: nothing for a
    /// session that holds all the request asks for.
    #[test]
    fn the_session_shortfall_is_what_the_session_bound_drops_or_narrows() {
        let requested = owned_scopes(&[
            "openid",
            "patient/Patient.read",
            "patient/Observation.rs",
            "patient/Condition.rs",
            "system/*.cruds",
            "wildflower/launch",
            "offline_access",
        ]);
        let session_grant = Grant::parse(["patient/Patient.rs", "patient/Observation.r"]);
        assert_eq!(
            session_shortfall(&requested, &session_grant),
            [
                "patient/Observation.s",
                "patient/Condition.rs",
                "system/*.cruds",
                "wildflower/launch",
            ],
        );
        // Of those, the session bound narrows two and drops the rest.
        assert_eq!(
            session_bounded_scopes(&requested, &session_grant),
            [
                "openid",
                "patient/Patient.read",
                "patient/Observation.r",
                "patient/Patient.rs",
                "offline_access",
            ],
        );
        assert!(session_shortfall(&requested, &Grant::parse(crate::owner_scopes())).is_empty());
    }

    /// A session's scopes cover a requested scope between them, and the
    /// shortfall names only the part none of them holds: `system/*.cuds` and
    /// `system/Patient.r` hold all of `system/Patient.rs` and all but `r` of
    /// `system/MedicationRequest.rs`.
    #[test]
    fn the_session_shortfall_is_the_part_the_session_s_scopes_together_lack() {
        let requested = owned_scopes(&["system/Patient.rs", "system/MedicationRequest.rs"]);
        let session_grant = Grant::parse(["system/*.cuds", "system/Patient.r"]);
        assert_eq!(
            session_shortfall(&requested, &session_grant),
            ["system/MedicationRequest.r"],
        );
        assert_eq!(
            session_bounded_scopes(&requested, &session_grant),
            ["system/Patient.rs", "system/MedicationRequest.s"],
        );
        // A word request lacks its leftover in letters; a held word counts as
        // its letters.
        assert_eq!(
            session_shortfall(
                &owned_scopes(&["patient/Observation.read", "patient/Patient.rs"]),
                &Grant::parse(["patient/Observation.r", "patient/Patient.read"]),
            ),
            ["patient/Observation.s"],
        );
    }

    /// An approver's scopes cover a requested scope between them, so one
    /// holding `system/*.cuds` and `system/Patient.r` may approve
    /// `system/Patient.rs` as asked.
    #[test]
    fn an_approver_s_scopes_together_cover_a_requested_scope() {
        let approver = grant(&["system/*.cuds", "system/Patient.r"]);
        let approvable = approvable(&["system/Patient.rs"], &["system/Patient.rs"]);
        assert_eq!(
            approvable.missing_approval_scopes(&approver),
            Vec::<String>::new()
        );
        assert_eq!(
            DelegatedScopes::clamp(&approver, owned_scopes(&["system/Patient.rs"]), &approvable)
                .expect("the approver covers it")
                .expect("granted")
                .scopes(),
            ["system/Patient.rs"],
        );
    }

    /// Only a code approval for a client trusted on first use writes the
    /// registration.
    #[test]
    fn only_a_trusted_on_first_use_code_approval_writes_the_registration() {
        let writes_registration = |approvable: &ApprovableScopes| {
            DelegatedScopes::clamp(
                &Grant::parse(crate::owner_scopes()),
                owned_scopes(&["openid"]),
                approvable,
            )
            .expect("the owner covers everything")
            .expect("granted")
            .would_write_registration()
        };
        let requested = owned_scopes(&["openid"]);
        let registered = client("app", &["openid"]);
        assert!(writes_registration(&ApprovableScopes::for_code(
            &requested,
            Some(&registered),
            false
        )));
        assert!(!writes_registration(&ApprovableScopes::for_code(
            &requested,
            Some(&registered),
            true
        )));
        assert!(!writes_registration(&device_prompt(&["openid"])));
    }
}
