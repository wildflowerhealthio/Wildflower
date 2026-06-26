//! OAuth 2.0 and SMART on FHIR scope primitives.
//!
//! Extracted so every slice that reasons about scopes shares one grammar
//! ([`smart`]) and one set of canonical scope strings, rather than each
//! re-deriving the SMART v1↔v2 mapping or hard-coding the same literals.
//! This is a faithful lift from gatekeeper-rust; behaviour is unchanged.

pub mod smart;

pub use smart::grantable_scopes;

/// OAuth scope that grants Owner-level access to the gatekeeper's
/// `/access/*` admin surface (client management, grant revocation, owner
/// consent endpoints). **Not** a SMART v2 scope and not parseable by
/// helios-auth's scope policy — `require_auth` does an exact-string match
/// against this constant. Pairing it with [`FULL_FHIR_ACCESS_SCOPE`] in
/// the owner token gives the host both admin and FHIR access without
/// overloading either scope's meaning.
pub const OWNER_SCOPE: &str = "wildflower/admin";

/// SMART v2 wildcard meaning "create / read / update / delete / search on
/// every resource type at the system access level". HFS's helios-auth scope
/// policy parses this and grants every FHIR operation. Granted alongside
/// [`OWNER_SCOPE`] in the boot owner token so the WebView's loopback FHIR
/// calls pass HFS's per-operation scope check.
pub const FULL_FHIR_ACCESS_SCOPE: &str = "system/*.cruds";

/// Scope that opts a grant into refresh-token issuance (SMART on FHIR's
/// `offline_access` convention). Without it `/token` responses carry no
/// `refresh_token`.
pub const OFFLINE_ACCESS_SCOPE: &str = "offline_access";

/// SMART scopes advertised in the EMR's `/.well-known/smart-configuration`
/// discovery document (`scopes_supported`). The values the public SMART App
/// Launch surface tells clients it will honour.
pub const SMART_SCOPES_SUPPORTED: &[&str] = &[
    "openid",
    "profile",
    "launch",
    "launch/patient",
    "patient/*.rs",
    "user/*.rs",
    "offline_access",
];
