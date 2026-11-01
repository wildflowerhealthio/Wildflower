//! Request-body and 404 schema types for the authorization server OAuth OpenAPI spec.
//!
//! These exist because the real handler payload types
//! (`super::token_exchange::TokenPayload`,
//! `super::device_authorization::DeviceAuthorizationPayload`,
//! `super::token_revocation::TokenRevocationPayload`) deliberately omit
//! the client credentials — `resolve_client_credentials` parses them from the
//! same form body out-of-band — so the on-the-wire request body has to model
//! `client_id`/`client_secret` back in. The 404 an unknown authorization
//! request gets is modelled here too; it is rendered by
//! `crate::http::errors::AuthorizationRequestNotFoundBody`. Referenced by
//! `#[utoipa::path(...)]` on the handlers; never constructed at runtime, hence
//! the file-level dead-code allowance.
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
    /// Redeem an authorization code with its PKCE verifier (RFC 6749 §4.1.3).
    #[serde(rename = "authorization_code")]
    AuthorizationCode {
        /// The client's id, for `client_secret_post` or a public client;
        /// omitted when it authenticates by `Authorization: Basic`.
        #[serde(skip_serializing_if = "Option::is_none")]
        client_id: Option<String>,
        /// A confidential client's secret, for `client_secret_post`; never
        /// beside a Basic header.
        #[serde(skip_serializing_if = "Option::is_none")]
        client_secret: Option<String>,
        /// The code `/oauth/authorize` sent to the client's redirect.
        code: String,
        /// The PKCE verifier whose S256 hash is the request's
        /// `code_challenge` (RFC 7636 §4.5).
        code_verifier: String,
        /// The same `redirect_uri` the authorization request named.
        redirect_uri: String,
    },
    /// Poll with a device code until the Owner decides (RFC 8628 §3.4).
    #[serde(rename = "urn:ietf:params:oauth:grant-type:device_code")]
    DeviceCode {
        /// The client's id, for `client_secret_post` or a public client;
        /// omitted when it authenticates by `Authorization: Basic`.
        #[serde(skip_serializing_if = "Option::is_none")]
        client_id: Option<String>,
        /// A confidential client's secret, for `client_secret_post`; never
        /// beside a Basic header.
        #[serde(skip_serializing_if = "Option::is_none")]
        client_secret: Option<String>,
        /// The `device_code` `/oauth/device_authorization` answered with.
        device_code: String,
    },
    /// Trade a live refresh token for a fresh access token and the refresh
    /// token's successor (RFC 6749 §6).
    #[serde(rename = "refresh_token")]
    RefreshToken {
        /// The client's id, for `client_secret_post` or a public client;
        /// omitted when it authenticates by `Authorization: Basic`.
        #[serde(skip_serializing_if = "Option::is_none")]
        client_id: Option<String>,
        /// A confidential client's secret, for `client_secret_post`; never
        /// beside a Basic header.
        #[serde(skip_serializing_if = "Option::is_none")]
        client_secret: Option<String>,
        /// The refresh token being rotated; it is spent by the trade.
        refresh_token: String,
    },
}

/// `POST /oauth/device_authorization` request body (RFC 8628 §3.1) — the
/// optional `scope` plus the body credentials, and the non-standard
/// `device_name` extension. Form-urlencoded.
#[derive(Serialize, ToSchema)]
pub(super) struct DeviceAuthorizationRequest {
    /// The client's id, for `client_secret_post` or a public client; omitted
    /// when it authenticates by `Authorization: Basic`.
    #[serde(skip_serializing_if = "Option::is_none")]
    client_id: Option<String>,
    /// A confidential client's secret, for `client_secret_post`; never beside
    /// a Basic header.
    #[serde(skip_serializing_if = "Option::is_none")]
    client_secret: Option<String>,
    /// The scopes the device asks for, space-separated; each must be one the
    /// client may ask for.
    #[serde(skip_serializing_if = "Option::is_none")]
    scope: Option<String>,
    /// Non-standard: a name for the device, shown to the approver. Without
    /// one, the device is named from its `User-Agent` when that names a
    /// browser or a system.
    #[serde(skip_serializing_if = "Option::is_none")]
    device_name: Option<String>,
}

/// `POST /oauth/revoke` request body (RFC 7009 §2.1) — the token plus the
/// body credentials. Form-urlencoded. `token_type_hint` is accepted and not
/// read: the server tells the token's type from the token.
#[derive(Serialize, ToSchema)]
pub(super) struct TokenRevocationRequestBody {
    /// The client's id, for `client_secret_post` or a public client; omitted
    /// when it authenticates by `Authorization: Basic`.
    #[serde(skip_serializing_if = "Option::is_none")]
    client_id: Option<String>,
    /// A confidential client's secret, for `client_secret_post`; never beside
    /// a Basic header.
    #[serde(skip_serializing_if = "Option::is_none")]
    client_secret: Option<String>,
    /// The client's own access or refresh token to revoke. A token that is
    /// unknown, already dead or another client's is answered `200` alike
    /// (RFC 7009 §2.2).
    token: String,
    /// `access_token` or `refresh_token`.
    #[serde(skip_serializing_if = "Option::is_none")]
    token_type_hint: Option<String>,
}

/// The JSON 404 body an unknown authorization request gets, from the status
/// poll and from the limited page's calls: also the answer to a caller whose
/// browser session may not read the request, so the two can't be told apart.
#[derive(Serialize, ToSchema)]
pub(super) struct AuthorizationRequestNotFound {
    /// Always `AuthorizationRequestNotFound`.
    error: String,
    /// The request id the caller asked about.
    id: String,
}

/// The JSON 404 body a session widening the caller may not see gets: from the
/// limited page's poll, one asked in another browser session, or none.
#[derive(Serialize, ToSchema)]
pub(super) struct SessionWideningNotFound {
    /// Always `SessionWideningNotFound`.
    error: String,
    /// The widening id the caller asked about.
    id: String,
}
