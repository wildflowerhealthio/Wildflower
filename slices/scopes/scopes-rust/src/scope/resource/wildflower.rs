//! The Wildflower resource scope — `wildflower/<Resource>.perms`.
//!
//! The context is fixed (the literal `wildflower`, so it's not a field) and the
//! resource is either the `*` wildcard or one of a closed set of
//! [`WildflowerResource`]s — mirroring [`ResourceType`](super::ResourceType)'s
//! `Wildcard`/`Known` shape, but over an enum rather than an open string.

use std::fmt;

use super::Permission;

/// The fixed context segment all Wildflower scopes share.
pub(in crate::scope) const CONTEXT: &str = "wildflower";

/// A scope addressing the app's own resources with a permission (set of
/// interactions), e.g. `wildflower/Grant.cruds` or `wildflower/*.cruds`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WildflowerResourceScope {
    pub resource: WildflowerResourceType,
    pub permission: Permission,
}

/// The resource a [`WildflowerResourceScope`] addresses: the `*` wildcard or one
/// of the closed set of [`WildflowerResource`]s.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WildflowerResourceType {
    /// `*` — every Wildflower resource at this access level.
    Wildcard,
    /// A specific Wildflower resource.
    Known(WildflowerResource),
}

/// A Wildflower-specific resource the gatekeeper governs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WildflowerResource {
    AuthorizationRequest,
    Grant,
    Client,
    /// An issued token (access **or** refresh) as a revocation target — the
    /// resource behind `POST /access/revocations`, which denylists a `jti` or
    /// bumps a subject's epoch and so kills *both* token kinds.
    Token,
    /// The apps catalogue + home-screen surface (`/apps`, `/cloud-apps`,
    /// `/self-hosted-apps`, `/system-apps`, `/home-screen`): read the catalogue
    /// (`.r`) and manage entries (`.c`/`.u`/`.d`). Launching an app is a separate,
    /// explicitly-granted capability — the `wildflower/launch` known scope
    /// ([`KnownScope::AnyScopedAppLaunch`](crate::KnownScope::AnyScopedAppLaunch))
    /// — not a permission on this resource.
    Apps,
    /// A collector "account" at a remote origin — the `/collector/remotes`
    /// surface (a remote's config may carry origin credentials, so reads need
    /// `.r`). The scope-layer name for what the collector code calls a `Remote`.
    Accounts,
    /// The tunnel/relay settings singleton (`/tunnel`): read state (`.r`) and
    /// replace settings (`.u`).
    TunnelSettings,
}

impl WildflowerResourceScope {
    /// Parse the `wildflower/Resource.perms` grammar — fixed `wildflower`
    /// context, the `*` wildcard or an explicit [`WildflowerResource`], and a
    /// v2 letter-bag permission (the v1 words `read`/`write`/`*` are FHIR-only,
    /// mirroring scopes-core's Cruds-only wildflower scopes) — or `None` if `s`
    /// isn't one.
    pub(in crate::scope) fn parse(s: &str) -> Option<Self> {
        let (ctx_str, rest) = s.split_once('/')?;
        if ctx_str != CONTEXT {
            return None;
        }
        let (type_str, perms_str) = rest.split_once('.')?;
        let resource = WildflowerResourceType::parse(type_str)?;
        let permission =
            Permission::parse_letter_segment(super::strip_search_suffix(s, perms_str))?;
        Some(WildflowerResourceScope {
            resource,
            permission,
        })
    }

    /// Does this (client-allowed) scope cover `other` (a requested scope)?
    /// Wildcard-aware resource match plus a permission superset.
    pub(in crate::scope) fn covers(&self, other: &WildflowerResourceScope) -> bool {
        self.resource.covers(&other.resource) && self.permission.contains(other.permission)
    }

    /// The single scope granting everything `self` and `other` do, or `None`
    /// when they name different resources. The FHIR counterpart's context check
    /// has no analogue here — the `wildflower` context is fixed — and the
    /// grammar check is vacuous, since these scopes parse letter-form only.
    pub(in crate::scope) fn merged(&self, other: &WildflowerResourceScope) -> Option<Self> {
        (self.resource == other.resource)
            .then(|| self.permission.union(other.permission))
            .flatten()
            .map(|permission| WildflowerResourceScope {
                permission,
                ..*self
            })
    }
}

impl WildflowerResourceType {
    /// `*` → wildcard; a known resource name → that resource; anything else →
    /// `None` (the Wildflower resource set is closed).
    pub(in crate::scope) fn parse(s: &str) -> Option<Self> {
        if s == "*" {
            Some(WildflowerResourceType::Wildcard)
        } else {
            WildflowerResource::parse(s).map(WildflowerResourceType::Known)
        }
    }

    pub(in crate::scope) fn name(&self) -> &'static str {
        match self {
            WildflowerResourceType::Wildcard => "*",
            WildflowerResourceType::Known(r) => r.as_str(),
        }
    }

    /// A wildcard covers any resource; otherwise resources must match exactly.
    pub(in crate::scope) fn covers(&self, other: &WildflowerResourceType) -> bool {
        *self == WildflowerResourceType::Wildcard || self == other
    }
}

impl WildflowerResource {
    pub(in crate::scope) fn parse(s: &str) -> Option<Self> {
        match s {
            "AuthorizationRequest" => Some(WildflowerResource::AuthorizationRequest),
            "Grant" => Some(WildflowerResource::Grant),
            "Client" => Some(WildflowerResource::Client),
            "Token" => Some(WildflowerResource::Token),
            "Apps" => Some(WildflowerResource::Apps),
            "Accounts" => Some(WildflowerResource::Accounts),
            "TunnelSettings" => Some(WildflowerResource::TunnelSettings),
            _ => None,
        }
    }

    pub(in crate::scope) fn as_str(self) -> &'static str {
        match self {
            WildflowerResource::AuthorizationRequest => "AuthorizationRequest",
            WildflowerResource::Grant => "Grant",
            WildflowerResource::Client => "Client",
            WildflowerResource::Token => "Token",
            WildflowerResource::Apps => "Apps",
            WildflowerResource::Accounts => "Accounts",
            WildflowerResource::TunnelSettings => "TunnelSettings",
        }
    }
}

impl fmt::Display for WildflowerResourceScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{CONTEXT}/{}.{}", self.resource.name(), self.permission)
    }
}
