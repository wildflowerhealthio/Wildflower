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
        }
    }
}
