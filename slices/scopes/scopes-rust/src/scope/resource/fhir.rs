//! The SMART on FHIR `context/Type.perms` resource scope and its parts.

use std::fmt;

use super::AccessRights;

/// A SMART on FHIR resource scope: an access level, the FHIR resource type it
/// addresses, and the CRUDS rights granted on it (`context/Type.perms`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct FhirResourceScope {
    pub context: ContextLevel,
    pub resource: ResourceType,
    pub access: AccessRights,
}

/// The access level a [`FhirResourceScope`] is relative to. `User` currently
/// grants the same as `System` (users don't exist yet), but the three are
/// modeled and compared **strictly** — `user` never silently means `system`.
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
        let access = AccessRights::parse_segment(super::strip_search_suffix(s, perms_str))?;
        Some(FhirResourceScope {
            context,
            resource: ResourceType::parse(type_str),
            access,
        })
    }

    /// Does this (client-allowed) scope cover `other` (a requested scope)? Strict
    /// context equality, wildcard-aware resource match, and a CRUDS superset.
    pub(in crate::scope) fn covers(&self, other: &FhirResourceScope) -> bool {
        self.context == other.context
            && self.resource.covers(&other.resource)
            && self.access.contains(other.access)
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
            self.access
        )
    }
}
