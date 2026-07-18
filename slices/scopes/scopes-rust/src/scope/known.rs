//! Broadly-known non-resource scopes (OIDC, launch context, refresh).

/// A broadly-known non-resource scope that matches exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum KnownScope {
    OfflineAccess,
    Openid,
    Profile,
    Launch,
    LaunchPatient,
    FhirUser,
    /// `wildflower/launch` — the umbrella app-launch capability. Holding it
    /// authorizes launching apps at all; a SMART app additionally requires the
    /// caller's grant to cover that app's own requested scopes. It is a *known*
    /// scope, matched exactly, so the `wildflower/*` resource wildcard does **not**
    /// cover it — launch is an explicitly-granted capability even for an owner
    /// token. (The `wildflower/` prefix is not a resource scope: with no `.perms`
    /// segment it never parses as [`WildflowerResourceScope`](super::WildflowerResourceScope).)
    AnyScopedAppLaunch,
}

impl KnownScope {
    pub(in crate::scope) fn parse(s: &str) -> Option<Self> {
        match s {
            "offline_access" => Some(KnownScope::OfflineAccess),
            "openid" => Some(KnownScope::Openid),
            "profile" => Some(KnownScope::Profile),
            "launch" => Some(KnownScope::Launch),
            "launch/patient" => Some(KnownScope::LaunchPatient),
            "fhirUser" => Some(KnownScope::FhirUser),
            "wildflower/launch" => Some(KnownScope::AnyScopedAppLaunch),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            KnownScope::OfflineAccess => "offline_access",
            KnownScope::Openid => "openid",
            KnownScope::Profile => "profile",
            KnownScope::Launch => "launch",
            KnownScope::LaunchPatient => "launch/patient",
            KnownScope::FhirUser => "fhirUser",
            KnownScope::AnyScopedAppLaunch => "wildflower/launch",
        }
    }
}
