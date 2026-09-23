//! [`DelegatedScopes`] — the proof that an approving Owner may delegate a scope
//! set to a client. Its one constructor, [`DelegatedScopes::clamp`], is the whole
//! of the "can't delegate more than you hold" rule.

use std::collections::HashSet;

use scopes_rust::{grantable_scopes, Grant, Scope};

use crate::domain::gatekeeper_error::GatekeeperError;

/// The scopes an approval may grant at most: those the request asked for that
/// the client is also allowed. The Owner's ticks are clamped into this
/// intersection; the approver's own grant then bounds it again. Each consent
/// flow decides both halves (the device flow passes the client's
/// `allowed_scopes` for both, since device consent is expandable; the code flow
/// allows the registration, widened by the request for a client trusted on
/// first use).
pub(crate) struct ApprovableScopes<'a> {
    pub(crate) requested_scopes: &'a HashSet<&'a str>,
    pub(crate) allowed_scopes: &'a HashSet<&'a str>,
}

/// A scope set an Owner has approved **and** is entitled to delegate. Holding
/// one is proof that every resource scope in it is covered by the approver's own
/// grant, so the writers that record grants and issue codes accept nothing else.
/// The fields are private and there is no other constructor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DelegatedScopes {
    scopes: Vec<String>,
}

impl DelegatedScopes {
    /// Clamp the Owner's `approved_scopes` ticks to the `approvable` scopes,
    /// then require that the `approver_grant` covers every **resource** scope
    /// that survives.
    ///
    /// `Ok(None)` when nothing survives — the caller denies. Identity and session
    /// markers (`openid`, `offline_access`, …) are not resource access and pass
    /// the approver check; a resource scope the approver lacks fails the whole
    /// approval (a `403`) rather than being silently dropped. Coverage is checked
    /// across both SMART spellings via [`Scope::as_alternate_canonical_form`],
    /// the twinning the token minter applies.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::InsufficientApproverScope`] naming the resource scopes
    /// the approver cannot delegate.
    pub(crate) fn clamp(
        approver_grant: &Grant,
        approved_scopes: Vec<String>,
        approvable: &ApprovableScopes<'_>,
    ) -> Result<Option<Self>, GatekeeperError> {
        let scopes = grantable_scopes(
            approved_scopes,
            approvable.requested_scopes,
            approvable.allowed_scopes,
        );
        if scopes.is_empty() {
            return Ok(None);
        }
        let missing_scopes = uncovered_resource_scopes(&scopes, approver_grant);
        if missing_scopes.is_empty() {
            Ok(Some(DelegatedScopes { scopes }))
        } else {
            Err(GatekeeperError::InsufficientApproverScope { missing_scopes })
        }
    }

    /// The delegated scopes, rendered — the set every write under this proof
    /// records verbatim.
    pub(crate) fn scopes(&self) -> &[String] {
        &self.scopes
    }
}

/// The resource scopes in `granted` the `approver_grant` does not cover,
/// checked across both canonical spellings.
fn uncovered_resource_scopes(granted: &[String], approver_grant: &Grant) -> Vec<String> {
    let approver_authority = Grant::new(
        approver_grant
            .scopes
            .iter()
            .flat_map(|held| [Some(held.clone()), held.as_alternate_canonical_form()])
            .flatten()
            .collect(),
    );
    let authorizes = |scope: &Scope| {
        approver_authority.covers(scope)
            || scope
                .as_alternate_canonical_form()
                .is_some_and(|twin| approver_authority.covers(&twin))
    };
    granted
        .iter()
        .filter(|rendered| {
            let scope = Scope::from(rendered.as_str());
            matches!(scope, Scope::FhirResource(_) | Scope::WildflowerResource(_))
                && !authorizes(&scope)
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::owned_scopes;

    fn set<'a>(scopes: &[&'a str]) -> HashSet<&'a str> {
        scopes.iter().copied().collect()
    }

    fn grant(scopes: &[&str]) -> Grant {
        Grant::parse(scopes.iter().copied())
    }

    /// The happy path: ticks inside the approvable scopes and inside the
    /// approver's own authority come back as the delegated set, verbatim.
    #[test]
    fn clamp_admits_covered_approvable_scopes() {
        let requested = set(&["patient/Patient.r", "openid"]);
        let allowed = set(&["patient/Patient.r", "openid", "patient/Observation.r"]);
        let delegated = DelegatedScopes::clamp(
            &grant(&["system/*.cruds"]),
            owned_scopes(&["patient/Patient.r", "openid"]),
            &ApprovableScopes {
                requested_scopes: &requested,
                allowed_scopes: &allowed,
            },
        )
        .expect("approver covers everything")
        .expect("something was granted");
        assert_eq!(delegated.scopes(), ["patient/Patient.r", "openid"]);
    }

    /// A tick outside the approvable scopes (requested ∩ allowed) is dropped,
    /// not delegated.
    #[test]
    fn clamp_drops_ticks_outside_the_approvable_scopes() {
        let requested = set(&["patient/Patient.r"]);
        let allowed = set(&["patient/Patient.r"]);
        let delegated = DelegatedScopes::clamp(
            &grant(&["system/*.cruds"]),
            owned_scopes(&["patient/Patient.r", "patient/Observation.r"]),
            &ApprovableScopes {
                requested_scopes: &requested,
                allowed_scopes: &allowed,
            },
        )
        .expect("approver covers everything")
        .expect("something was granted");
        assert_eq!(delegated.scopes(), ["patient/Patient.r"]);
    }

    /// Nothing surviving the clamp is `None`, so the caller denies rather than
    /// recording an empty grant.
    #[test]
    fn clamp_yields_none_when_nothing_survives() {
        let requested = set(&["patient/Patient.r"]);
        let allowed = set(&["patient/Patient.r"]);
        let delegated = DelegatedScopes::clamp(
            &grant(&["system/*.cruds"]),
            owned_scopes(&["patient/Observation.r"]),
            &ApprovableScopes {
                requested_scopes: &requested,
                allowed_scopes: &allowed,
            },
        )
        .expect("no approver check runs on an empty set");
        assert_eq!(delegated, None);
    }

    /// The escalation the proof exists to rule out: a resource scope the approver
    /// does not hold fails the approval and names the scope, rather than being
    /// delegated or silently narrowed.
    #[test]
    fn clamp_rejects_a_resource_scope_the_approver_does_not_hold() {
        let requested = set(&["patient/Patient.r", "patient/Observation.r"]);
        let allowed = requested.clone();
        let outcome = DelegatedScopes::clamp(
            &grant(&["patient/Patient.r"]),
            owned_scopes(&["patient/Patient.r", "patient/Observation.r"]),
            &ApprovableScopes {
                requested_scopes: &requested,
                allowed_scopes: &allowed,
            },
        );
        assert_eq!(
            outcome,
            Err(GatekeeperError::InsufficientApproverScope {
                missing_scopes: owned_scopes(&["patient/Observation.r"]),
            }),
        );
    }

    /// An approver holding nothing at all can delegate no resource scope — the
    /// "gain scope from nothing" case.
    #[test]
    fn clamp_rejects_every_resource_scope_for_an_empty_approver() {
        let requested = set(&["patient/Patient.r"]);
        let allowed = requested.clone();
        let outcome = DelegatedScopes::clamp(
            &grant(&[]),
            owned_scopes(&["patient/Patient.r"]),
            &ApprovableScopes {
                requested_scopes: &requested,
                allowed_scopes: &allowed,
            },
        );
        assert!(matches!(
            outcome,
            Err(GatekeeperError::InsufficientApproverScope { .. })
        ));
    }

    /// Identity and session markers are not resource access, so an approver who
    /// holds none of them may still delegate them.
    #[test]
    fn clamp_passes_identity_markers_through_the_approver_check() {
        let requested = set(&["openid", "offline_access"]);
        let allowed = requested.clone();
        let delegated = DelegatedScopes::clamp(
            &grant(&["patient/Patient.r"]),
            owned_scopes(&["openid", "offline_access"]),
            &ApprovableScopes {
                requested_scopes: &requested,
                allowed_scopes: &allowed,
            },
        )
        .expect("markers need no resource authority")
        .expect("granted");
        assert_eq!(delegated.scopes().len(), 2);
    }

    /// The v1-word / v2-letter bridge: an approver holding the letter form covers
    /// a delegation spelled in the word form, and vice versa.
    #[test]
    fn clamp_covers_across_the_two_smart_spellings() {
        let requested = set(&["patient/Patient.read"]);
        let allowed = requested.clone();
        let delegated = DelegatedScopes::clamp(
            &grant(&["patient/Patient.rs"]),
            owned_scopes(&["patient/Patient.read"]),
            &ApprovableScopes {
                requested_scopes: &requested,
                allowed_scopes: &allowed,
            },
        )
        .expect("letter authority covers the word spelling")
        .expect("granted");
        assert_eq!(delegated.scopes(), ["patient/Patient.read"]);
    }
}
