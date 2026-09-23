//! [`DelegatedScopes`] — the proof that an approving Owner may delegate a scope
//! set to a client. Its one constructor, [`DelegatedScopes::clamp`], is the whole
//! of the "can't delegate more than you hold" rule.

use std::collections::HashSet;

use scopes_rust::{grantable_scopes, Grant, Scope};

use crate::domain::client::Client;
use crate::domain::gatekeeper_error::GatekeeperError;

/// The scopes one consent prompt may grant at most, decided by its flow. An
/// approved scope must be covered by a scope of the request **and** by a scope
/// of the client's allowance; each constructor names the policy that fills
/// those two halves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ApprovableScopes {
    requested_scopes: Vec<String>,
    allowed_scopes: Vec<String>,
}

impl ApprovableScopes {
    /// A device-code prompt. Device consent is **expandable**: the Owner may
    /// grant anything the client is allowed, whatever the device asked for, so
    /// the client's `allowed_scopes` fill both halves.
    pub(crate) fn for_device(client: &Client) -> Self {
        ApprovableScopes {
            requested_scopes: client.allowed_scopes.clone(),
            allowed_scopes: client.allowed_scopes.clone(),
        }
    }

    /// An authorization-code prompt for `requested_scopes`. A locked
    /// registration (the first-party host) allows only what it lists; any other
    /// client is trusted on first use, so it is also allowed what this request
    /// asked for — its registration is widened with the grant.
    pub(crate) fn for_code(
        requested_scopes: &[String],
        maybe_existing_client: Option<&Client>,
        registration_is_locked: bool,
    ) -> Self {
        let registered_scopes = maybe_existing_client
            .iter()
            .flat_map(|client| client.allowed_scopes.iter().cloned());
        let allowed_scopes = if registration_is_locked {
            registered_scopes.collect()
        } else {
            registered_scopes
                .chain(requested_scopes.iter().cloned())
                .collect()
        };
        ApprovableScopes {
            requested_scopes: requested_scopes.to_vec(),
            allowed_scopes,
        }
    }

    /// The subset of the Owner's `approved_scopes` this prompt may grant: each
    /// one covered by a requested scope and by an allowed scope (coverage, not
    /// spelling — see [`scopes_rust::grantable_scopes`]). Rendered in canonical
    /// form, deduplicated, in the Owner's order.
    pub(crate) fn grantable_subset(&self, approved_scopes: Vec<String>) -> Vec<String> {
        let requested: HashSet<&str> = self.requested_scopes.iter().map(String::as_str).collect();
        let allowed: HashSet<&str> = self.allowed_scopes.iter().map(String::as_str).collect();
        grantable_scopes(approved_scopes, &requested, &allowed)
    }
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
    /// Clamp the Owner's `approved_scopes` to the `approvable` scopes' grantable
    /// subset,
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
        approvable: &ApprovableScopes,
    ) -> Result<Option<Self>, GatekeeperError> {
        let scopes = approvable.grantable_subset(approved_scopes);
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
    use crate::domain::test_fake::{client, owned_scopes};

    /// A prompt for a locked registration: exactly what `requested` asks
    /// within what `allowed` lists.
    fn approvable(requested: &[&str], allowed: &[&str]) -> ApprovableScopes {
        ApprovableScopes::for_code(
            &owned_scopes(requested),
            Some(&client("app", allowed)),
            true,
        )
    }

    fn grant(scopes: &[&str]) -> Grant {
        Grant::parse(scopes.iter().copied())
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
        let requested: &[&str] = &["patient/Patient.r", "patient/Observation.r"];
        let allowed = requested;
        let outcome = DelegatedScopes::clamp(
            &grant(&["patient/Patient.r"]),
            owned_scopes(&["patient/Patient.r", "patient/Observation.r"]),
            &approvable(requested, allowed),
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
        let requested: &[&str] = &["patient/Patient.r"];
        let allowed = requested;
        let outcome = DelegatedScopes::clamp(
            &grant(&[]),
            owned_scopes(&["patient/Patient.r"]),
            &approvable(requested, allowed),
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
            ApprovableScopes::for_device(&client("tv", &["patient/*.rs", "offline_access"]));
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
    /// a locked registration may not.
    #[test]
    fn a_code_prompt_widens_the_allowance_only_for_an_unlocked_registration() {
        let requested = owned_scopes(&["patient/Patient.r", "openid"]);
        let registered = client("app", &["openid"]);
        let approved = || owned_scopes(&["patient/Patient.r", "openid"]);

        let unlocked = ApprovableScopes::for_code(&requested, Some(&registered), false);
        assert_eq!(
            unlocked.grantable_subset(approved()),
            ["patient/Patient.r", "openid"]
        );
        let unknown = ApprovableScopes::for_code(&requested, None, false);
        assert_eq!(
            unknown.grantable_subset(approved()),
            ["patient/Patient.r", "openid"]
        );

        let locked = ApprovableScopes::for_code(&requested, Some(&registered), true);
        assert_eq!(locked.grantable_subset(approved()), ["openid"]);
    }

    /// Even for an unlocked registration, a code prompt never grants past what
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
}
