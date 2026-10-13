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
//! `/.well-known/smart-configuration` and put HFS's router behind it as a
//! fallback (see [`lib.rs`](crate)). The advertised endpoints are the
//! gatekeeper URLs on the same origin, so the SMART app fetches discovery
//! here, then follows links straight to gatekeeper for the authorize/token
//! dance.
//!
//! This is the sole discovery implementation; the former TypeScript twin in the
//! fhir-r4 slice has been removed.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use serde::Serialize;
use wildflowerhealthio_shared_structures::served_origin::served_base_url_for;

/// State threaded to the discovery handler: the loopback origin it falls back
/// to when a request arrives without forwarding headers (a typed
/// [`Url`](url::Url) base URL; the handler derives the bare origin string from
/// it), and the server's origin it reports as `issuer`.
#[derive(Clone)]
pub(crate) struct SmartConfigState {
    pub loopback_base_url: url::Url,
    /// The server's bare origin, every token's `iss` and `aud`.
    pub server_origin: String,
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

/// The SMART capability that tells a client this is a Wildflower server rather
/// than a plain SMART one: both serve FHIR at the URL a client signs in to, so
/// the launcher reads it to choose what it offers. The document is committed as
/// `snapshots/smart-configuration.json`, which `authorization-core`'s discovery
/// tests read, so the client is tested against what this serves.
pub(crate) const WILDFLOWER_SERVER_CAPABILITY: &str = "wildflower-server";

/// The SMART scopes advertised in discovery — the standard public SMART App
/// Launch read set. Hand-curated (a `const`, built once) rather than enumerated
/// from `scopes-rust`, so the public document never exposes the system's
/// internal/admin scope vocabulary.
const SCOPES_SUPPORTED: &[&str] = &[
    "openid",
    "profile",
    "launch",
    "launch/patient",
    "patient/*.cruds",
    "user/*.cruds",
    "system/*.cruds",
    "offline_access",
];

fn build_smart_configuration(server_origin: &str, base_url: &url::Url) -> SmartConfiguration {
    // The advertised endpoints are per-request URL strings; derive the bare
    // origin (no trailing slash, no default port) once and interpolate.
    let origin = wildflowerhealthio_shared_structures::origin_string(base_url);
    SmartConfiguration {
        // `issuer` = the server's origin (minted tokens' `iss`); the endpoint
        // URLs below stay per-request, derived from the served origin. See
        // `docs/Origins/Explanation.md`.
        issuer: server_origin.to_owned(),
        jwks_uri: format!("{origin}/.well-known/jwks.json"),
        authorization_endpoint: format!("{origin}/oauth/authorize"),
        token_endpoint: format!("{origin}/oauth/token"),
        registration_endpoint: format!("{origin}/auth/register"),
        management_endpoint: format!("{origin}/user/manage"),
        introspection_endpoint: format!("{origin}/user/introspect"),
        revocation_endpoint: format!("{origin}/user/revoke"),
        scopes_supported: SCOPES_SUPPORTED.to_vec(),
        response_types_supported: vec!["code"],
        grant_types_supported: vec!["authorization_code", "client_credentials"],
        token_endpoint_auth_methods_supported: vec!["client_secret_basic", "private_key_jwt"],
        code_challenge_methods_supported: vec!["S256"],
        capabilities: vec![
            "launch-ehr",
            "permission-patient",
            "permission-v1",
            "permission-v2",
            "client-public",
            "client-confidential-symmetric",
            "context-ehr-patient",
            "sso-openid-connect",
            WILDFLOWER_SERVER_CAPABILITY,
        ],
        associated_endpoints: vec![],
    }
}

pub(crate) async fn smart_configuration_handler(
    State(state): State<SmartConfigState>,
    headers: HeaderMap,
) -> Response {
    // No served base URL (a forwarded header that cleared validation but failed to
    // parse) → 500 rather than a discovery doc with malformed URLs.
    let Some(base_url) = served_base_url_for(&headers, &state.loopback_base_url) else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    Json(build_smart_configuration(&state.server_origin, &base_url)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVER_ORIGIN: &str = "https://ruth.wildflowerhealth.io";

    fn base(value: &str) -> url::Url {
        url::Url::parse(value).unwrap()
    }

    /// The committed document `authorization-core`'s discovery tests read
    /// (`smart-discovery.test.ts`), so the TS client is tested against exactly
    /// what this serves. Regenerate with
    /// `UPDATE_SMART_CONFIGURATION=1 cargo test -p wildflowerhealthio-fhir-r4 smart_configuration_snapshot`.
    #[test]
    fn smart_configuration_snapshot_is_up_to_date() {
        let doc =
            build_smart_configuration(SERVER_ORIGIN, &base("https://ruth.wildflowerhealth.io"));
        let rendered = format!(
            "{}\n",
            serde_json::to_string_pretty(&doc).expect("serialize the discovery document")
        );
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("snapshots")
            .join("smart-configuration.json");
        if std::env::var_os("UPDATE_SMART_CONFIGURATION").is_some() {
            std::fs::create_dir_all(path.parent().expect("snapshot dir")).expect("create dir");
            std::fs::write(&path, &rendered).expect("write the snapshot");
        }
        let committed = std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "read {}: {e}; regenerate with UPDATE_SMART_CONFIGURATION=1",
                path.display()
            )
        });
        assert_eq!(
            committed, rendered,
            "stale snapshot; regenerate with UPDATE_SMART_CONFIGURATION=1"
        );
    }

    #[test]
    fn discovery_doc_points_authorization_endpoint_at_root_oauth() {
        let doc =
            build_smart_configuration(SERVER_ORIGIN, &base("https://ruth.wildflowerhealth.io"));
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
    }

    /// `issuer` is the server's origin whichever origin discovery was served
    /// on, while the endpoint URLs follow the served origin.
    #[test]
    fn discovery_doc_reports_the_server_origin_as_issuer() {
        let doc = build_smart_configuration(SERVER_ORIGIN, &base("http://127.0.0.1:8080/"));
        assert_eq!(doc.issuer, SERVER_ORIGIN);
        assert_eq!(doc.token_endpoint, "http://127.0.0.1:8080/oauth/token");
    }

    #[test]
    fn discovery_doc_advertises_smart_app_launch_capabilities() {
        let doc = build_smart_configuration(SERVER_ORIGIN, &base("https://example.com"));
        assert!(doc.capabilities.contains(&"launch-ehr"));
        assert!(doc.capabilities.contains(&"permission-v2"));
        assert!(doc.grant_types_supported.contains(&"authorization_code"));
        assert!(doc.response_types_supported.contains(&"code"));
        assert!(doc.code_challenge_methods_supported.contains(&"S256"));
    }

    #[test]
    fn discovery_doc_advertises_curated_public_scopes() {
        let doc = build_smart_configuration(SERVER_ORIGIN, &base("https://example.com"));
        // The curated public SMART read set — standard SMART App Launch scopes,
        // not the system's internal/admin vocabulary.
        assert!(doc.scopes_supported.contains(&"openid"));
        assert!(doc.scopes_supported.contains(&"patient/*.cruds"));
        assert!(doc.scopes_supported.contains(&"offline_access"));
        assert!(doc.scopes_supported.contains(&"system/*.cruds"));
        // Internal/system-wide scopes are NOT advertised publicly.
        assert!(!doc
            .scopes_supported
            .iter()
            .any(|s| s.starts_with("wildflower/")));
    }
}
