//! Request-body and 404 schema types for the gatekeeper OAuth OpenAPI spec.
//!
//! These exist because the real handler payload types
//! (`super::token_exchange::TokenPayload`,
//! `super::device_authorization::DeviceAuthorizationPayload`) deliberately omit
//! the client credentials — `resolve_client_credentials` parses them from the
//! same form body out-of-band — so the on-the-wire request body has to model
//! `client_id`/`client_secret` back in. The 404 body has no Rust type either
//! (it's a `serde_json::json!` literal in `not_found`), so it is modelled here
//! too. Referenced by `#[utoipa::path(...)]` on the handlers; never constructed
//! at runtime, hence the file-level dead-code allowance.
#![allow(dead_code)]

use serde::Serialize;
use utoipa::ToSchema;

/// `POST /oauth/token` request body — the `grant_type`-tagged union of the
/// three grants the endpoint dispatches (mirrors
/// `super::token_exchange::TokenPayload` plus the body credentials).
/// Form-urlencoded (RFC 6749 §3.2). `client_id`/`client_secret` are optional:
/// a confidential client may instead authenticate via `Authorization: Basic`
/// (RFC 6749 §2.3.1) and omit them from the body — `resolve_client_credentials`
/// accepts either source.
#[derive(Serialize, ToSchema)]
#[serde(tag = "grant_type")]
pub(super) enum TokenRequestBody {
    #[serde(rename = "authorization_code")]
    AuthorizationCode {
        #[serde(skip_serializing_if = "Option::is_none")]
        client_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        client_secret: Option<String>,
        code: String,
        code_verifier: String,
        redirect_uri: String,
    },
    #[serde(rename = "urn:ietf:params:oauth:grant-type:device_code")]
    DeviceCode {
        #[serde(skip_serializing_if = "Option::is_none")]
        client_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        client_secret: Option<String>,
        device_code: String,
    },
    #[serde(rename = "refresh_token")]
    RefreshToken {
        #[serde(skip_serializing_if = "Option::is_none")]
        client_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        client_secret: Option<String>,
        refresh_token: String,
    },
}

/// `POST /oauth/device_authorization` request body (RFC 8628 §3.1) — the
/// optional `scope` plus the body credentials, and the non-standard
/// `device_name` extension. Form-urlencoded.
#[derive(Serialize, ToSchema)]
pub(super) struct DeviceAuthorizationRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    client_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_secret: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_name: Option<String>,
}

/// The JSON 404 body `not_found("AuthorizationRequestNotFound", "id", ...)`
/// renders for an unknown authorization request.
#[derive(Serialize, ToSchema)]
pub(super) struct AuthorizationRequestNotFound {
    error: String,
    id: String,
}
