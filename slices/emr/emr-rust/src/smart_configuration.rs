//! `/.well-known/smart-configuration` override mounted ahead of HFS.
//!
//! HFS's built-in discovery doc ([discovery.rs](~/Documents/hfs/crates/auth/src/discovery.rs))
//! is shaped for SMART Backend Services — it hardcodes
//! `token_endpoint_auth_methods_supported: ["private_key_jwt"]` and only
//! advertises `client_credentials`. Public SMART App Launch clients (e.g.
//! the SMART growth-chart sample) need the `authorization_code` grant, an
//! `authorization_endpoint`, and a different auth-methods list.
//!
//! Rather than patching helios-auth upstream, we mount this handler at
//! `/fhir-r4/.well-known/smart-configuration` and put HFS's router behind
//! it as a fallback (see [`lib.rs`](crate)). The advertised endpoints are
//! the gatekeeper URLs that already exist at the host root, so the SMART
//! app fetches discovery here, then follows links straight to gatekeeper
//! for the authorize/token dance.
//!
//! Mirrors the (now-superseded) TypeScript implementation at
//! `slices/emr/fhir-r4/src/http-api-implementation/smart-configuration.ts`.

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Json;
use serde::Serialize;
use shared_structures_rust::served_origin::served_origin_for;
use shared_structures_rust::CANONICAL_ISSUER;

/// State threaded to the discovery handler so it can fall back to the
/// loopback origin when a request arrives without forwarding headers.
#[derive(Clone)]
pub(crate) struct SmartConfigState {
    pub loopback_origin: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct SmartConfiguration {
    issuer: String,
    jwks_uri: String,
    authorization_endpoint: String,
    token_endpoint: String,
    registration_endpoint: String,
    management_endpoint: String,
    introspection_endpoint: String,
    revocation_endpoint: String,
    scopes_supported: Vec<&'static str>,
    response_types_supported: Vec<&'static str>,
    grant_types_supported: Vec<&'static str>,
    token_endpoint_auth_methods_supported: Vec<&'static str>,
    code_challenge_methods_supported: Vec<&'static str>,
    capabilities: Vec<&'static str>,
    associated_endpoints: Vec<&'static str>,
}

fn build_smart_configuration(origin: &str) -> SmartConfiguration {
    let host = format!("{origin}/fhir-r4");
    SmartConfiguration {
        // `issuer` matches the `iss` claim gatekeeper writes into every
        // minted token — SMART clients that compare the two see the same
        // string. The endpoint URLs below stay per-request so the SMART
        // app can actually reach them from where it is.
        issuer: CANONICAL_ISSUER.to_string(),
        jwks_uri: format!("{origin}/.well-known/jwks.json"),
        authorization_endpoint: format!("{origin}/oauth/authorize"),
        token_endpoint: format!("{origin}/oauth/token"),
        registration_endpoint: format!("{host}/auth/register"),
        management_endpoint: format!("{host}/user/manage"),
        introspection_endpoint: format!("{host}/user/introspect"),
        revocation_endpoint: format!("{host}/user/revoke"),
        scopes_supported: vec![
            "openid",
            "profile",
            "launch",
            "launch/patient",
            "patient/*.rs",
            "user/*.rs",
            "offline_access",
        ],
        response_types_supported: vec!["code"],
        grant_types_supported: vec!["authorization_code", "client_credentials"],
        token_endpoint_auth_methods_supported: vec!["client_secret_basic", "private_key_jwt"],
        code_challenge_methods_supported: vec!["S256"],
        capabilities: vec![
            "launch-ehr",
            "permission-patient",
            "permission-v2",
            "client-public",
            "client-confidential-symmetric",
            "context-ehr-patient",
            "sso-openid-connect",
        ],
        associated_endpoints: vec![],
    }
}

pub(crate) async fn smart_configuration_handler(
    State(state): State<SmartConfigState>,
    headers: HeaderMap,
) -> Json<SmartConfiguration> {
    let origin = served_origin_for(&headers, &state.loopback_origin);
    Json(build_smart_configuration(&origin))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_doc_points_authorization_endpoint_at_root_oauth() {
        let doc = build_smart_configuration("https://ruth.wildflowerhealth.io");
        assert_eq!(
            doc.authorization_endpoint,
            "https://ruth.wildflowerhealth.io/oauth/authorize"
        );
        assert_eq!(
            doc.token_endpoint,
            "https://ruth.wildflowerhealth.io/oauth/token"
        );
        assert_eq!(
            doc.jwks_uri,
            "https://ruth.wildflowerhealth.io/.well-known/jwks.json"
        );
        // `issuer` is the canonical constant, not the per-request origin
        // (matching the `iss` claim in gatekeeper-minted JWTs).
        assert_eq!(doc.issuer, CANONICAL_ISSUER);
    }

    #[test]
    fn discovery_doc_advertises_smart_app_launch_capabilities() {
        let doc = build_smart_configuration("https://example.com");
        assert!(doc.capabilities.contains(&"launch-ehr"));
        assert!(doc.capabilities.contains(&"permission-v2"));
        assert!(doc.grant_types_supported.contains(&"authorization_code"));
        assert!(doc.response_types_supported.contains(&"code"));
        assert!(doc.code_challenge_methods_supported.contains(&"S256"));
    }
}
