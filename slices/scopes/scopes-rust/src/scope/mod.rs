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
//! **round-trips** (SMART v1↔v2 back-compat — see [`Permission`]).
//!
//! A [`Grant`] is an ordered collection of these scopes — the structured form of
//! the scope lists callers store, transmit, and check coverage against.

mod grant;
mod known;
mod resource;
mod unknown;

use std::convert::Infallible;
use std::fmt;
use std::str::FromStr;

use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub use grant::Grant;
pub use known::KnownScope;
pub use resource::{
    ContextLevel, FhirResourceScope, Permission, ResourceType, WildflowerResource,
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
    /// Build a `wildflower/<Resource>.<perm>` scope on one of the app's own
    /// resources — the typed way to name a Wildflower scope, so consumers
    /// (gatekeeper's admin gate, host config) don't hand-spell scope strings or
    /// re-declare a local constructor.
    #[must_use]
    pub fn wildflower(resource: WildflowerResource, permission: Permission) -> Scope {
        Scope::WildflowerResource(WildflowerResourceScope {
            resource: WildflowerResourceType::Known(resource),
            permission,
        })
    }

    /// Build a `wildflower/*.<perm>` scope — every Wildflower resource at this
    /// permission (the wildcard an owner or a broad admin token carries).
    #[must_use]
    pub fn wildflower_all(permission: Permission) -> Scope {
        Scope::WildflowerResource(WildflowerResourceScope {
            resource: WildflowerResourceType::Wildcard,
            permission,
        })
    }

    /// Build a `system/*.<perm>` FHIR scope — every FHIR resource type at the
    /// `system` access level and this permission. The typed way to name the broad
    /// backend-service FHIR scope (e.g. `system/*.rs` to export the clinical
    /// database) without string-parsing.
    #[must_use]
    pub fn fhir_system_all(permission: Permission) -> Scope {
        Scope::FhirResource(FhirResourceScope {
            context: ContextLevel::System,
            resource: ResourceType::Wildcard,
            permission,
        })
    }

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
                permission: r.permission.to_interaction_set_representation(),
                ..r.clone()
            }),
            Scope::WildflowerResource(w) => Scope::WildflowerResource(WildflowerResourceScope {
                permission: w.permission.to_interaction_set_representation(),
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
mod tests;
