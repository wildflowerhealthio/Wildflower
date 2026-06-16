//! Code-first OpenAPI 3.1 spec for the gatekeeper's public OAuth + discovery
//! surface — the `/.well-known/jwks.json`, `/oauth/authorize`,
//! `/oauth/authorize/{id}`, `/oauth/token`, and `/oauth/device_authorization`
//! routes wired in [`super::router`] and [`crate::http::handlers::jwks`].
//!
//! This is a deliberately scoped **trial**: only the OAuth group + jwks are
//! covered (the `/access/*` admin surface is not). The method/path/status
//! declarations on the `*_doc` functions are hand-written to mirror the real
//! route table, while every request/response **schema** is derived
//! (`#[derive(ToSchema)]`) from the real serde wire types — so a change to a
//! wire struct flows into the spec automatically. That derived-schema half is
//! the drift-detection value: it is what the TS spec-drift test in
//! `gatekeeper-core` diffs against the Effect `HttpApi`.
//!
//! The generated spec is snapshotted at
//! `openapi/gatekeeper-oauth.openapi.json`; the [`tests`] module keeps it fresh.
//! Regenerate after changing a wire type with:
//!
//! ```sh
//! UPDATE_OPENAPI=1 cargo test -p gatekeeper-rust openapi_spec_snapshot_is_up_to_date
//! ```

// The `*_doc` functions and the request-body schema structs in this module
// exist solely to carry `#[utoipa::path]` / `#[derive(ToSchema)]` annotations
// for spec generation. Nothing calls or constructs them at runtime, so
// dead-code analysis (correctly) sees them as unused — silence it file-wide
// rather than peppering each item.
#![allow(dead_code)]

use serde::Serialize;
use utoipa::{IntoParams, OpenApi, ToSchema};

use super::authorization_status::AuthorizationStatus;
use super::device_authorization::DeviceAuthorizationResponse;
use super::internal::{OAuthError, TokenResponse};
use crate::crypto_util::public_jwk::PublicJwk;
use crate::http::handlers::jwks::Jwks;

// ---- Request-body / parameter schemas ---------------------------------------
//
// The real handler payload types (`super::token_exchange::TokenPayload`,
// `super::device_authorization::DeviceAuthorizationPayload`) deliberately omit
// the client credentials, which `resolve_client_credentials` parses from the
// same form body out-of-band. These doc types add `client_id`/`client_secret`
// back so the spec describes the full wire body a client actually sends —
// matching the hand-written TS contract.

/// `POST /oauth/token` request body — the `grant_type`-tagged union of the three
/// grants the endpoint dispatches (mirrors `super::token_exchange::TokenPayload`
/// plus the body credentials). Form-urlencoded (RFC 6749 §3.2).
#[derive(Serialize, ToSchema)]
#[serde(tag = "grant_type")]
enum TokenRequest {
    #[serde(rename = "authorization_code")]
    AuthorizationCode {
        client_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        client_secret: Option<String>,
        code: String,
        code_verifier: String,
        redirect_uri: String,
    },
    #[serde(rename = "urn:ietf:params:oauth:grant-type:device_code")]
    DeviceCode {
        client_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        client_secret: Option<String>,
        device_code: String,
    },
    #[serde(rename = "refresh_token")]
    RefreshToken {
        client_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        client_secret: Option<String>,
        refresh_token: String,
    },
}

/// `POST /oauth/device_authorization` request body (RFC 8628 §3.1) — the
/// optional `scope` plus the body credentials. Form-urlencoded.
#[derive(Serialize, ToSchema)]
struct DeviceAuthorizationRequest {
    client_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_secret: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scope: Option<String>,
}

/// The JSON 404 body `not_found("AuthorizationRequestNotFound", "id", ...)`
/// renders for an unknown authorization request.
#[derive(Serialize, ToSchema)]
struct AuthorizationRequestNotFound {
    error: String,
    id: String,
}

/// Query parameters accepted at `GET /oauth/authorize` (RFC 6749 §4.1.1 + PKCE).
#[derive(Serialize, IntoParams)]
#[into_params(parameter_in = Query)]
struct AuthorizeQueryParams {
    response_type: String,
    code_challenge_method: String,
    client_id: String,
    scope: String,
    code_challenge: String,
    redirect_uri: String,
    state: String,
}

// ---- Path declarations (mirror the real route table) ------------------------

/// `GET /.well-known/jwks.json` — [`crate::http::handlers::jwks::route`].
#[utoipa::path(
    get,
    path = "/.well-known/jwks.json",
    responses((status = 200, description = "RFC 7517 JSON Web Key Set", body = Jwks))
)]
fn jwks_json() {}

/// `GET /oauth/authorize` — browser front door. Success is a 302 (back to the
/// client or to the owner-approval UI); there is no JSON success body, so the
/// TS spec-drift test compares only this endpoint's *parameters*, not its
/// responses (see the accepted-differences list in the test).
#[utoipa::path(
    get,
    path = "/oauth/authorize",
    params(AuthorizeQueryParams),
    responses(
        (status = 302, description = "Redirect to the client redirect_uri or the owner approval UI"),
        (status = 400, description = "Local HTML error page (untrusted client / redirect_uri)"),
        (status = 503, description = "No active signing key")
    )
)]
fn authorize() {}

/// `GET /oauth/authorize/{id}` — poll a pending authorization request.
#[utoipa::path(
    get,
    path = "/oauth/authorize/{id}",
    params(("id" = String, Path, description = "Authorization request id")),
    responses(
        (status = 200, description = "Current authorization-request status", body = AuthorizationStatus),
        (status = 404, description = "No authorization request with that id", body = AuthorizationRequestNotFound),
        (status = 500, description = "Server error (RFC 6749 §5.2)", body = OAuthError)
    )
)]
fn authorization_status() {}

/// `POST /oauth/token` — token endpoint (RFC 6749 §3.2 / RFC 8628 §3.4).
#[utoipa::path(
    post,
    path = "/oauth/token",
    request_body(
        content = TokenRequest,
        content_type = "application/x-www-form-urlencoded"
    ),
    responses(
        (status = 200, description = "Successful token response (RFC 6749 §5.1)", body = TokenResponse),
        (status = 400, description = "OAuth error (RFC 6749 §5.2 / RFC 8628 §3.5)", body = OAuthError),
        (status = 401, description = "Client authentication failed (RFC 6749 §5.2)", body = OAuthError),
        (status = 500, description = "Server error (RFC 6749 §5.2)", body = OAuthError)
    )
)]
fn token_exchange() {}

/// `POST /oauth/device_authorization` — device authorization endpoint
/// (RFC 8628 §3.1).
#[utoipa::path(
    post,
    path = "/oauth/device_authorization",
    request_body(
        content = DeviceAuthorizationRequest,
        content_type = "application/x-www-form-urlencoded"
    ),
    responses(
        (status = 200, description = "Device + user code pair (RFC 8628 §3.2)", body = DeviceAuthorizationResponse),
        (status = 400, description = "OAuth error (RFC 6749 §5.2)", body = OAuthError),
        (status = 401, description = "Client authentication failed (RFC 6749 §5.2)", body = OAuthError)
    )
)]
fn device_authorization() {}

#[derive(OpenApi)]
#[openapi(
    paths(
        jwks_json,
        authorize,
        authorization_status,
        token_exchange,
        device_authorization
    ),
    components(schemas(
        Jwks,
        PublicJwk,
        TokenResponse,
        OAuthError,
        AuthorizationStatus,
        DeviceAuthorizationResponse,
        TokenRequest,
        DeviceAuthorizationRequest,
        AuthorizationRequestNotFound
    ))
)]
struct GatekeeperOpenApi;

/// The gatekeeper OAuth+discovery OpenAPI document. `info` is set explicitly so
/// the snapshot doesn't churn when the crate version changes.
pub(crate) fn openapi() -> utoipa::openapi::OpenApi {
    let mut spec = GatekeeperOpenApi::openapi();
    spec.info = utoipa::openapi::Info::new("Gatekeeper OAuth API", "0.0.0");
    spec
}

/// The spec as pretty-printed JSON (trailing newline added by the writer), for
/// the committed snapshot the TS spec-drift test consumes.
pub(crate) fn openapi_json() -> String {
    serde_json::to_string_pretty(&openapi()).expect("serialize gatekeeper OpenAPI to JSON")
}

#[cfg(test)]
mod tests {
    use super::openapi_json;

    /// The committed spec snapshot the TS spec-drift test reads.
    const SPEC_PATH: &str =
        concat!(env!("CARGO_MANIFEST_DIR"), "/openapi/gatekeeper-oauth.openapi.json");

    /// The generated OpenAPI document must match the committed snapshot. A wire
    /// type change flips this red; regenerate with
    /// `UPDATE_OPENAPI=1 cargo test -p gatekeeper-rust openapi_spec_snapshot_is_up_to_date`.
    #[test]
    fn openapi_spec_snapshot_is_up_to_date() {
        let generated = format!("{}\n", openapi_json());
        if std::env::var_os("UPDATE_OPENAPI").is_some() {
            std::fs::write(SPEC_PATH, &generated).expect("write OpenAPI snapshot");
            return;
        }
        let committed = std::fs::read_to_string(SPEC_PATH).expect(
            "read committed OpenAPI snapshot; regenerate with \
             UPDATE_OPENAPI=1 cargo test -p gatekeeper-rust openapi_spec_snapshot_is_up_to_date",
        );
        assert_eq!(
            committed, generated,
            "gatekeeper OpenAPI spec is out of date — regenerate with \
             UPDATE_OPENAPI=1 cargo test -p gatekeeper-rust openapi_spec_snapshot_is_up_to_date"
        );
    }
}
