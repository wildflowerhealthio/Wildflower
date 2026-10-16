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
//! authorization server URLs on the server's origin, so the SMART app fetches
//! discovery here, then follows links straight to the authorization server for
//! the authorize/token dance.
//!
//! The document advertises only what is served: every endpoint URL in it is a
//! route this server answers, apart from `management_endpoint`, the hosted
//! Wildflower Authorization app ([`AuthorizationAppBase`]). That app
//! configures itself from this document, so it is the app's contract.
//!
//! This is the sole discovery implementation; the former TypeScript twin in the
//! fhir-r4 slice has been removed.

use axum::extract::State;
use axum::response::Json;
use serde::Serialize;
use wildflowerhealthio_shared_structures::authorization_app::AuthorizationAppBase;

/// State threaded to the discovery handler: the server's origin it reports as
/// `issuer` and builds every endpoint URL on, and the Wildflower Authorization
/// app it advertises as `management_endpoint`.
#[derive(Clone)]
pub(crate) struct SmartConfigState {
    /// The server's bare origin, every token's `iss` and `aud`.
    pub server_origin: String,
    pub authorization_app_base: AuthorizationAppBase,
}

#[derive(Debug, Serialize)]
pub(crate) struct SmartConfiguration {
    issuer: String,
    jwks_uri: String,
    authorization_endpoint: String,
    token_endpoint: String,
    /// The Wildflower Authorization app, pointed at this server's `issuer`.
    management_endpoint: String,
    /// A Wildflower extension field: the base of the authorization server's
    /// JSON API (`/authorization/`), which the Wildflower Authorization app
    /// reads rather than hardcoding a server path.
    wildflower_authorization_api: String,
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

/// The grants `/oauth/token` accepts: the authorization server's
/// `TokenPayload`.
const GRANT_TYPES_SUPPORTED: &[&str] = &[
    "authorization_code",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:device_code",
];

/// How a client authenticates at `/oauth/token`: a confidential client's
/// secret in an `Authorization: Basic` header or in the form body (the
/// authorization server's `resolve_client_credentials`), or, for a public
/// client, its `client_id` alone.
const TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED: &[&str] =
    &["client_secret_basic", "client_secret_post", "none"];

fn build_smart_configuration(
    server_origin: &str,
    authorization_app_base: &AuthorizationAppBase,
) -> SmartConfiguration {
    SmartConfiguration {
        // `issuer` = the server's origin (minted tokens' `iss`), and every
        // endpoint URL below is on it too. See `docs/Origins/Explanation.md`.
        issuer: server_origin.to_owned(),
        jwks_uri: format!("{server_origin}/.well-known/jwks.json"),
        authorization_endpoint: format!("{server_origin}/oauth/authorize"),
        token_endpoint: format!("{server_origin}/oauth/token"),
        management_endpoint: authorization_app_base
            .management_url(server_origin)
            .to_string(),
        wildflower_authorization_api: format!("{server_origin}/authorization/"),
        scopes_supported: SCOPES_SUPPORTED.to_vec(),
        response_types_supported: vec!["code"],
        grant_types_supported: GRANT_TYPES_SUPPORTED.to_vec(),
        token_endpoint_auth_methods_supported: TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED.to_vec(),
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
) -> Json<SmartConfiguration> {
    Json(build_smart_configuration(
        &state.server_origin,
        &state.authorization_app_base,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVER_ORIGIN: &str = "https://ruth.wildflowerhealth.io";

    /// The document, advertising the hosted app.
    fn document() -> SmartConfiguration {
        let authorization_app =
            AuthorizationAppBase::parse("https://authorization.wildflowerhealth.io/")
                .expect("valid base");
        build_smart_configuration(SERVER_ORIGIN, &authorization_app)
    }

    /// The committed document `authorization-core`'s discovery tests read
    /// (`smart-discovery.test.ts`), so the TS client is tested against exactly
    /// what this serves. Regenerate with
    /// `UPDATE_SMART_CONFIGURATION=1 cargo test -p wildflowerhealthio-fhir-r4 smart_configuration_snapshot`.
    #[test]
    fn smart_configuration_snapshot_is_up_to_date() {
        let doc = document();
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
        let doc = document();
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

    /// `issuer` is the server's origin.
    #[test]
    fn discovery_doc_reports_the_server_origin_as_issuer() {
        assert_eq!(document().issuer, SERVER_ORIGIN);
    }

    /// The management page is the hosted app pointed at the `issuer`, and the
    /// authorization API is on the server's origin like the endpoints.
    #[test]
    fn discovery_doc_points_management_at_the_app_and_the_api_at_the_server_origin() {
        let doc = document();
        assert_eq!(
            doc.management_endpoint,
            "https://authorization.wildflowerhealth.io/?iss=https%3A%2F%2Fruth.wildflowerhealth.io"
        );
        assert_eq!(
            doc.wildflower_authorization_api,
            "https://ruth.wildflowerhealth.io/authorization/"
        );
    }

    #[test]
    fn discovery_doc_advertises_smart_app_launch_capabilities() {
        let doc = document();
        assert!(doc.capabilities.contains(&"launch-ehr"));
        assert!(doc.capabilities.contains(&"permission-v2"));
        assert!(doc.grant_types_supported.contains(&"authorization_code"));
        assert!(doc.response_types_supported.contains(&"code"));
        assert!(doc.code_challenge_methods_supported.contains(&"S256"));
    }

    #[test]
    fn discovery_doc_advertises_curated_public_scopes() {
        let doc = document();
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
