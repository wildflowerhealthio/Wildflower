//! The SMART on FHIR `context/Type.perms` resource scope and its parts.

use std::fmt;

use super::Permission;

/// A SMART on FHIR resource scope: an access level, the FHIR resource type it
/// addresses, and the permission (set of interactions) granted on it
/// (`context/Type.perms`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct FhirResourceScope {
    pub context: ContextLevel,
    pub resource: ResourceType,
    pub permission: Permission,
}

/// The access level a [`FhirResourceScope`] is relative to. `System` covers
/// every context; `User` and `Patient` cover only themselves — a patient-launch
/// scope is bound to the launch patient (possibly a record outside the user's
/// own access), so neither is a subset of the other. The three stay distinct
/// *values* (a `user` scope renders as `user`, never silently `system`); only
/// [`covers`](ContextLevel::covers) applies the rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ContextLevel {
    Patient,
    User,
    System,
}

/// The FHIR resource type a [`FhirResourceScope`] addresses: the `*` wildcard or
/// a named FHIR resource type (modeled as a string — HFS exposes no usable
/// resource-type enum). Wildflower's own resources are **not** modeled here; they
/// live under [`WildflowerResource`](super::WildflowerResource) and are
/// unreachable via the FHIR `*` wildcard.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ResourceType {
    /// `*` — every FHIR resource type at this access level.
    Wildcard,
    /// A named (non-wildcard) FHIR resource type, e.g. `"Observation"`.
    Known(String),
}

impl FhirResourceScope {
    /// Parse the `context/Type.perms` FHIR grammar (context ∈
    /// `patient`/`user`/`system`), or `None` if `s` isn't one.
    pub(in crate::scope) fn parse(s: &str) -> Option<Self> {
        let (ctx_str, rest) = s.split_once('/')?;
        let context = ContextLevel::parse(ctx_str)?;
        let (type_str, perms_str) = rest.split_once('.')?;
        if type_str.is_empty() {
            return None;
        }
        let permission = Permission::parse_segment(super::strip_search_suffix(s, perms_str))?;
        Some(FhirResourceScope {
            context,
            resource: ResourceType::parse(type_str),
            permission,
        })
    }

    /// Does this (client-allowed) scope cover `other` (a requested scope)?
    /// Context coverage (`system` covers everything; `user`/`patient` only
    /// themselves), wildcard-aware resource match, and a permission-bit superset
    /// (a v2 letter permission covers the equivalent v1 word, but not the reverse
    /// — see [`Permission::contains`](super::Permission::contains)).
    pub(in crate::scope) fn covers(&self, other: &FhirResourceScope) -> bool {
        self.context.covers(other.context)
            && self.resource.covers(&other.resource)
            && self.permission.contains(other.permission)
    }

    /// The single scope granting everything `self` and `other` do, or `None`
    /// when they can't be stated as one. Both must name the **same** context and
    /// resource type — `system` covering `user` is subsumption, not a merge, and
    /// collapsing them here would lose the narrower context's own spelling — and
    /// their permissions must share a grammar
    /// ([`Permission::union`](super::Permission::union)).
    pub(in crate::scope) fn merged(&self, other: &FhirResourceScope) -> Option<Self> {
        (self.context == other.context && self.resource == other.resource)
            .then(|| self.permission.union(other.permission))
            .flatten()
            .map(|permission| FhirResourceScope {
                permission,
                ..self.clone()
            })
    }
}

impl ContextLevel {
    pub(in crate::scope) fn parse(s: &str) -> Option<Self> {
        match s {
            "patient" => Some(ContextLevel::Patient),
            "user" => Some(ContextLevel::User),
            "system" => Some(ContextLevel::System),
            _ => None,
        }
    }

    pub(in crate::scope) fn as_str(self) -> &'static str {
        match self {
            ContextLevel::Patient => "patient",
            ContextLevel::User => "user",
            ContextLevel::System => "system",
        }
    }

    /// Does this context grant everything `other` does? `system` covers every
    /// context; `user` and `patient` cover only themselves.
    pub(in crate::scope) fn covers(self, other: ContextLevel) -> bool {
        self == ContextLevel::System || self == other
    }
}

impl ResourceType {
    /// Resolve a resource-type segment. `*` → wildcard; anything else → a named
    /// FHIR resource type. Total.
    pub(in crate::scope) fn parse(s: &str) -> Self {
        if s == "*" {
            ResourceType::Wildcard
        } else {
            ResourceType::Known(s.to_string())
        }
    }

    pub(in crate::scope) fn name(&self) -> &str {
        match self {
            ResourceType::Wildcard => "*",
            ResourceType::Known(t) => t,
        }
    }

    /// A wildcard covers any resource type; otherwise types must match exactly.
    pub(in crate::scope) fn covers(&self, other: &ResourceType) -> bool {
        *self == ResourceType::Wildcard || self == other
    }
}

impl fmt::Display for FhirResourceScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}/{}.{}",
            self.context.as_str(),
            self.resource.name(),
            self.permission
        )
    }
}
