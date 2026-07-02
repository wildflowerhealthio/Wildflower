//! A [`Grant`] — an ordered collection of [`Scope`]s, the structured form of the
//! scope lists stored in client `allowed_scopes` / grant rows and minted into a
//! token's space-joined `scope` claim.
//!
//! The sibling modules model one scope each; a `Grant` is the whole *set*, with
//! the collection-level operations — render, coverage, kind projections —
//! callers would otherwise open-code over a `&[Scope]`. It mirrors `scopes-core`'s
//! `domain/grant.ts`.

use crate::scope::{KnownScope, Scope};

/// An ordered collection of [`Scope`]s — a parsed grant. Order is preserved so a
/// grant round-trips through [`parse`](Grant::parse) → [`render`](Grant::render)
/// in the spelling it was given.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Grant {
    /// The grant's scopes, in their original order.
    pub scopes: Vec<Scope>,
}

impl Grant {
    /// A grant over the given scopes.
    pub fn new(scopes: Vec<Scope>) -> Self {
        Self { scopes }
    }

    /// Parse a list of scope strings into a grant. Total — each string parses to
    /// its richest [`Scope`], falling back to [`Unknown`](Scope::Unknown), so no
    /// input is ever dropped.
    pub fn parse<I, S>(raw: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        Self::new(raw.into_iter().map(|s| Scope::from(s.as_ref())).collect())
    }

    /// Render every scope to its canonical wire string (SMART v1↔v2 back-compat —
    /// see [`Permission`](crate::Permission)). The list-level counterpart of
    /// [`Scope`]'s [`Display`](std::fmt::Display); shares [`render_scopes`](crate::render_scopes).
    pub fn render(&self) -> Vec<String> {
        crate::render_scopes(&self.scopes)
    }

    /// Does any scope in this grant cover `scope`? This is the coverage test a
    /// client's `allowed_scopes` are run through when deciding what an approval
    /// may grant (see [`Scope::covers`]).
    pub fn covers(&self, scope: &Scope) -> bool {
        self.scopes.iter().any(|s| s.covers(scope))
    }

    /// The structured FHIR/Wildflower resource scopes in the grant.
    pub fn resource_scopes(&self) -> impl Iterator<Item = &Scope> + '_ {
        self.scopes
            .iter()
            .filter(|s| matches!(s, Scope::FhirResource(_) | Scope::WildflowerResource(_)))
    }

    /// The broadly-known (flag) scopes in the grant, e.g. `openid` / `offline_access`.
    pub fn known_scopes(&self) -> impl Iterator<Item = KnownScope> + '_ {
        self.scopes.iter().filter_map(|s| match s {
            Scope::Known(k) => Some(*k),
            _ => None,
        })
    }

    /// Whether the grant holds a given flag scope.
    pub fn has_known(&self, flag: KnownScope) -> bool {
        self.known_scopes().any(|k| k == flag)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_renders_round_trips_each_scope_in_order() {
        let raw = [
            "openid",
            "patient/Observation.rs",
            "wildflower/Grant.cruds",
            "a_stray_unknown",
        ];
        let grant = Grant::parse(raw);
        // Each string parsed to a Scope (none dropped) and renders back verbatim,
        // in the original order.
        assert_eq!(grant.scopes.len(), 4);
        assert_eq!(grant.render(), raw);
    }

    #[test]
    fn covers_delegates_to_any_member_scope() {
        // A `system/*.cruds` member covers a specific narrower request...
        let grant = Grant::parse(["system/*.cruds", "openid"]);
        assert!(grant.covers(&Scope::from("system/Patient.r")));
        assert!(grant.covers(&Scope::from("openid")));
        // ...but nothing in the grant reaches a `user/` scope or an unrequested flag.
        assert!(!grant.covers(&Scope::from("user/Patient.r")));
        assert!(!grant.covers(&Scope::from("offline_access")));
        // The empty grant covers nothing.
        assert!(!Grant::default().covers(&Scope::from("openid")));
    }

    #[test]
    fn projections_split_scopes_by_kind() {
        let grant = Grant::parse([
            "openid",
            "offline_access",
            "patient/Observation.rs",
            "wildflower/Grant.cruds",
            "a_stray_unknown",
        ]);
        assert_eq!(grant.resource_scopes().count(), 2);
        assert_eq!(
            grant.known_scopes().collect::<Vec<_>>(),
            vec![KnownScope::Openid, KnownScope::OfflineAccess]
        );
        assert!(grant.has_known(KnownScope::Openid));
        assert!(!grant.has_known(KnownScope::FhirUser));
    }
}
