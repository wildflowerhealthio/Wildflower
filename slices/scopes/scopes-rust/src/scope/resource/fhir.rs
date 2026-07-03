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

/// The access level a [`FhirResourceScope`] is relative to. Coverage is
/// **hierarchical** — `System ⊇ User ⊇ Patient` (a broader launch context
/// grants everything a narrower one does), matching the reach of the SMART
/// launch contexts. The three stay distinct *values* (a `user` scope renders as
/// `user`, never silently `system`); only [`covers`](ContextLevel::covers)
/// applies the order.
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
    /// Hierarchical context (`system ⊇ user ⊇ patient`), wildcard-aware resource
    /// match, and a permission superset.
    pub(in crate::scope) fn covers(&self, other: &FhirResourceScope) -> bool {
        self.context.covers(other.context)
            && self.resource.covers(&other.resource)
            && self.permission.contains(other.permission)
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

    /// Does this context grant everything `other` does? Hierarchical —
    /// `System ⊇ User ⊇ Patient` — so a context always covers itself and any
    /// narrower one, and never a broader one.
    pub(in crate::scope) fn covers(self, other: ContextLevel) -> bool {
        self.reach() >= other.reach()
    }

    /// The breadth rank used by [`covers`](ContextLevel::covers): higher is broader.
    fn reach(self) -> u8 {
        match self {
            ContextLevel::Patient => 0,
            ContextLevel::User => 1,
            ContextLevel::System => 2,
        }
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
