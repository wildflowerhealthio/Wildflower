//! The structured, owned [`Scope`] model: a SMART-on-FHIR-compatible value type
//! every slice can parse into, match on, render, and enumerate.
//!
//! A [`Scope`] is one of four kinds:
//!
//! * [`FhirResource`](Scope::FhirResource) — a SMART `context/Type.perms` FHIR
//!   scope (the `resource::fhir` module).
//! * [`WildflowerResource`](Scope::WildflowerResource) — a `wildflower/Resource.perms`
//!   scope on one of the app's own resources (the `resource::wildflower` module);
//!   these are **not** reachable through the FHIR `*` wildcard.
//! * [`Known`](Scope::Known) — a broadly-known non-resource scope like `openid`
//!   (the `known` module).
//! * [`Unknown`](Scope::Unknown) — anything else, preserved verbatim (the
//!   `unknown` module).
//!
//! Parsing (via [`From`]/[`FromStr`]) is **total** — it never fails, it falls
//! back to `Unknown` — and prefers the richest representation. Rendering
//! **round-trips** (SMART v1↔v2 back-compat — see [`AccessRights`]).

mod known;
mod resource;
mod unknown;

use std::convert::Infallible;
use std::fmt;
use std::str::FromStr;

use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub use known::KnownScope;
pub use resource::{
    AccessRights, ContextLevel, FhirResourceScope, ResourceType, WildflowerResource,
    WildflowerResourceScope, WildflowerResourceType,
};
pub use unknown::UnknownScope;

/// An OAuth 2.0 / SMART on FHIR scope. Build from a string with [`From`] or
/// [`FromStr`] (both infallible — parsing is total, falling back to
/// [`Unknown`](Scope::Unknown)); render with [`Display`](fmt::Display).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Scope {
    /// A SMART `context/Type.perms` FHIR resource scope.
    FhirResource(FhirResourceScope),
    /// A `wildflower/Resource.perms` scope on one of the app's own resources.
    WildflowerResource(WildflowerResourceScope),
    /// A broadly-known non-resource scope (`openid`, `offline_access`, …).
    Known(KnownScope),
    /// Anything unrecognized, preserved verbatim.
    Unknown(UnknownScope),
}

impl Scope {
    /// Does this (client-allowed) scope cover `other` (a requested scope)?
    /// Resource scopes compare structurally within their kind; known and unknown
    /// scopes — and any cross-kind pair — match exactly.
    pub fn covers(&self, other: &Scope) -> bool {
        match (self, other) {
            (Scope::FhirResource(a), Scope::FhirResource(b)) => a.covers(b),
            (Scope::WildflowerResource(a), Scope::WildflowerResource(b)) => a.covers(b),
            (a, b) => a == b,
        }
    }

    /// An equivalent alternate spelling of this scope — the same grant rendered
    /// in its *other* canonical form — or `None` when it has no distinct
    /// alternate. Today the only scopes with one are resource scopes whose access
    /// is a SMART v1 word: they return the canonical v2 letter form
    /// (`patient/Observation.read` → `patient/Observation.rs`, `.write` →
    /// `.cud`, `.*` → `.cruds`). Non-resource scopes, and resource scopes already
    /// in letter form, have none. The alternate covers exactly the same
    /// operations; emitting both lets a letter-only consumer honor a v1 grant
    /// (see [`with_alternate_canonical_forms`](crate::with_alternate_canonical_forms)).
    pub fn as_alternate_canonical_form(&self) -> Option<Scope> {
        let alternate = match self {
            Scope::FhirResource(r) => Scope::FhirResource(FhirResourceScope {
                access: r.access.to_letter_bag_representation(),
                ..r.clone()
            }),
            Scope::WildflowerResource(w) => Scope::WildflowerResource(WildflowerResourceScope {
                access: w.access.to_letter_bag_representation(),
                ..w.clone()
            }),
            Scope::Known(_) | Scope::Unknown(_) => return None,
        };
        (alternate != *self).then_some(alternate)
    }
}

impl From<&str> for Scope {
    /// Parse a scope string, preferring the richest representation
    /// (known → wildflower → FHIR → unknown). Total — never fails.
    ///
    /// A trailing SMART v2 search-parameter suffix (anything from a `?`) is
    /// dropped with a `tracing::warn!` — `patient/Observation.rs?category=x`
    /// parses as `patient/Observation.rs`.
    fn from(s: &str) -> Self {
        if let Some(known) = KnownScope::parse(s) {
            return Scope::Known(known);
        }
        if let Some(wildflower) = WildflowerResourceScope::parse(s) {
            return Scope::WildflowerResource(wildflower);
        }
        if let Some(fhir) = FhirResourceScope::parse(s) {
            return Scope::FhirResource(fhir);
        }
        Scope::Unknown(UnknownScope::new(s))
    }
}

impl FromStr for Scope {
    /// Parsing is total, so the error is the never type [`Infallible`].
    type Err = Infallible;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Scope::from(s))
    }
}

impl fmt::Display for Scope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Scope::FhirResource(r) => write!(f, "{r}"),
            Scope::WildflowerResource(w) => write!(f, "{w}"),
            Scope::Known(k) => f.write_str(k.as_str()),
            Scope::Unknown(u) => write!(f, "{u}"),
        }
    }
}

impl Serialize for Scope {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Scope {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ScopeVisitor;
        impl Visitor<'_> for ScopeVisitor {
            type Value = Scope;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an OAuth/SMART scope string")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Scope, E> {
                Ok(Scope::from(v))
            }
        }
        deserializer.deserialize_str(ScopeVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// `rs` access rights, built through the parser so these tests don't reach
    /// into `AccessRights`' private representation.
    fn rs() -> AccessRights {
        AccessRights::parse_segment("rs").unwrap()
    }

    #[test]
    fn parse_prefers_known_over_resource() {
        assert_eq!(Scope::from("openid"), Scope::Known(KnownScope::Openid));
        assert_eq!(
            Scope::from("launch/patient"),
            Scope::Known(KnownScope::LaunchPatient)
        );
    }

    #[test]
    fn parse_fhir_resource_richest() {
        assert_eq!(
            Scope::from("patient/Observation.read"),
            Scope::FhirResource(FhirResourceScope {
                context: ContextLevel::Patient,
                resource: ResourceType::Known("Observation".to_string()),
                access: AccessRights::parse_segment("read").unwrap(),
            })
        );
        assert_eq!(
            Scope::from("system/*.cruds"),
            Scope::FhirResource(FhirResourceScope {
                context: ContextLevel::System,
                resource: ResourceType::Wildcard,
                access: AccessRights::ALL,
            })
        );
    }

    #[test]
    fn wildflower_scopes_are_their_own_kind() {
        // `wildflower/Grant.cruds` is a Wildflower scope...
        assert_eq!(
            Scope::from("wildflower/Grant.cruds"),
            Scope::WildflowerResource(WildflowerResourceScope {
                resource: WildflowerResourceType::Known(WildflowerResource::Grant),
                access: AccessRights::ALL,
            })
        );
        // ...whereas `system/Grant.cruds` is just a FHIR scope named "Grant" —
        // the Wildflower resource set is reachable *only* under `wildflower/`.
        assert_eq!(
            Scope::from("system/Grant.cruds"),
            Scope::FhirResource(FhirResourceScope {
                context: ContextLevel::System,
                resource: ResourceType::Known("Grant".to_string()),
                access: AccessRights::ALL,
            })
        );
    }

    #[test]
    fn parse_falls_back_to_unknown() {
        // Retired admin scope, an unknown wildflower resource, and a stray-letter
        // perm bag all preserve verbatim rather than misparse.
        for s in [
            "wildflower/admin",
            "wildflower/Nope.cruds",
            "patient/Observation.rx",
        ] {
            assert_eq!(Scope::from(s), Scope::Unknown(UnknownScope::new(s)));
        }
    }

    #[test]
    fn display_round_trips_v1_words_and_canonicalizes_letter_order() {
        // SMART v1 word forms round-trip verbatim (back-compat: a v1 grant is
        // returned as v1, not collapsed to its letter equivalent).
        assert_eq!(
            Scope::from("patient/Observation.read").to_string(),
            "patient/Observation.read"
        );
        assert_eq!(
            Scope::from("wildflower/Grant.*").to_string(),
            "wildflower/Grant.*"
        );
        assert_eq!(
            Scope::from("wildflower/*.write").to_string(),
            "wildflower/*.write"
        );
        // v2 letter bags normalize to canonical c,r,u,d,s order.
        assert_eq!(
            Scope::from("patient/Observation.sr").to_string(),
            "patient/Observation.rs"
        );
        assert_eq!(Scope::from("system/*.cruds").to_string(), "system/*.cruds");
        // Non-resource scopes round-trip unchanged.
        assert_eq!(Scope::from("openid").to_string(), "openid");
    }

    #[test]
    fn parse_strips_search_param_suffix() {
        let scope = Scope::from("patient/Observation.rs?category=http://x|y");
        assert_eq!(
            scope,
            Scope::FhirResource(FhirResourceScope {
                context: ContextLevel::Patient,
                resource: ResourceType::Known("Observation".to_string()),
                access: rs(),
            })
        );
        assert_eq!(scope.to_string(), "patient/Observation.rs");
    }

    #[test]
    fn covers_fhir_rules() {
        let covers = |a: &str, b: &str| Scope::from(a).covers(&Scope::from(b));
        assert!(covers("system/*.cruds", "system/Patient.r")); // wildcard + perm subset
        assert!(covers("patient/Observation.read", "patient/Observation.rs")); // v1 covers v2
        assert!(!covers("system/*.cruds", "user/Patient.r")); // strict context
        assert!(!covers("system/Patient.r", "system/Patient.cruds")); // perm not covered
        assert!(!covers("system/Patient.cruds", "system/*.cruds")); // specific !covers wildcard
    }

    #[test]
    fn covers_wildflower_rules() {
        let covers = |a: &str, b: &str| Scope::from(a).covers(&Scope::from(b));
        assert!(covers("wildflower/Grant.cruds", "wildflower/Grant.read")); // perm subset
        assert!(covers("wildflower/*.cruds", "wildflower/Grant.read")); // wildcard covers any
        assert!(!covers("wildflower/Grant.cruds", "wildflower/Client.read")); // explicit resource
        assert!(!covers("wildflower/Grant.cruds", "wildflower/*.read")); // specific !covers wildcard
                                                                         // FHIR full access does NOT reach Wildflower resources, and vice versa.
        assert!(!covers("system/*.cruds", "wildflower/Grant.cruds"));
        assert!(!covers("wildflower/Grant.cruds", "system/Grant.cruds"));
    }

    #[test]
    fn covers_known_and_unknown_match_exactly() {
        assert!(Scope::from("offline_access").covers(&Scope::from("offline_access")));
        assert!(!Scope::from("offline_access").covers(&Scope::from("openid")));
        assert!(Scope::from("wildflower/admin").covers(&Scope::from("wildflower/admin")));
        assert!(!Scope::from("system/*.cruds").covers(&Scope::from("offline_access")));
    }

    #[test]
    fn from_and_fromstr_agree() {
        assert_eq!(Scope::from("openid"), "openid".parse::<Scope>().unwrap());
        assert_eq!(
            Scope::from("wildflower/Grant.cruds"),
            "wildflower/Grant.cruds".parse::<Scope>().unwrap()
        );
    }

    #[test]
    fn wildflower_scopes_round_trip_byte_compatibly() {
        for s in [
            "wildflower/*.cruds",
            "wildflower/Grant.cruds",
            "wildflower/AuthorizationRequest.rs",
            "wildflower/Client.cud",
        ] {
            assert_eq!(Scope::from(s).to_string(), s);
            assert_eq!(
                serde_json::to_string(&Scope::from(s)).unwrap(),
                serde_json::to_string(s).unwrap()
            );
        }
    }

    /// Canonical CRUDS letters for a raw bit set, independent of `AccessRights`'
    /// private representation.
    fn canonical_letters(bits: u8) -> String {
        [(1u8, 'c'), (2, 'r'), (4, 'u'), (8, 'd'), (16, 's')]
            .into_iter()
            .filter(|(b, _)| bits & b != 0)
            .map(|(_, c)| c)
            .collect()
    }

    proptest! {
        /// A canonical FHIR scope string serializes byte-identically whether it's
        /// a `String` or a parsed `Scope` — the property a future
        /// `JsonColumn<Vec<Scope>>` relies on to avoid a migration.
        #[test]
        fn serde_is_byte_compatible_for_canonical_scopes(
            ctx in prop::sample::select(vec!["patient", "user", "system"]),
            rtype in prop::sample::select(vec!["*", "Patient", "Observation"]),
            bits in 1u8..=31u8,
        ) {
            let canonical = format!("{ctx}/{rtype}.{}", canonical_letters(bits));
            let via_scope = serde_json::to_string(&Scope::from(canonical.as_str())).unwrap();
            let via_string = serde_json::to_string(&canonical).unwrap();
            prop_assert_eq!(via_scope, via_string);
        }
    }
}
