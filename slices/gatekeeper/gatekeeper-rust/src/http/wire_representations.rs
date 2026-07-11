//! Request/response wire shapes shared across the gatekeeper's route trees —
//! the JSON bodies the OAuth surface and the Owner UI post and read. Routes and
//! loaders import their DTOs from here instead of a sibling `internal.rs`, so a
//! shape shared by two surfaces (e.g. [`ApproveBody`] across both consent
//! flows) has one home and the trees can't drift.
//!
//! Also home to [`CacheSuppressed`], the RFC 6749 §5.1/§5.2 cache-suppression
//! wrapper the token-surface responses render through — a wire concern (headers
//! on the response), not route logic.

use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::domain::oauth_error_code::OAuthErrorCode;

/// Wrapper that stamps the RFC 6749 §5.1/§5.2 cache-suppression headers
/// (`Cache-Control: no-store`, `Pragma: no-cache`) onto the wrapped response.
/// Token- and device-authorization-endpoint responses — success or error —
/// must never be cached; wrapping makes that part of the value instead of a
/// step a call site can forget.
pub(crate) struct CacheSuppressed<T>(pub(crate) T);

impl<T: IntoResponse> IntoResponse for CacheSuppressed<T> {
    fn into_response(self) -> Response {
        (
            [
                (header::CACHE_CONTROL, "no-store"),
                (header::PRAGMA, "no-cache"),
            ],
            self.0,
        )
            .into_response()
    }
}

/// RFC 6749 §5.1 successful token-endpoint response.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct TokenResponse {
    pub(crate) access_token: String,
    pub(crate) token_type: String,
    pub(crate) expires_in: i64,
    pub(crate) scope: String,
    /// Present only when the grant carries [`scopes_rust::KnownScope::OfflineAccess`]
    /// — the plaintext of the freshly-minted refresh-token generation (RFC 6749
    /// §5.1; only its hash is persisted).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) refresh_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) patient: Option<String>,
}

impl IntoResponse for TokenResponse {
    /// RFC 6749 §5.1: a token response MUST carry `Cache-Control: no-store` —
    /// rendering through [`CacheSuppressed`] makes that unforgettable.
    fn into_response(self) -> Response {
        CacheSuppressed(Json(self)).into_response()
    }
}

/// RFC 6749 §5.2 token-endpoint error body.
#[derive(Debug, Serialize, Deserialize, Clone, ToSchema)]
pub(crate) struct OAuthError {
    pub(crate) error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error_description: Option<String>,
}

impl OAuthError {
    pub(crate) fn new(error: OAuthErrorCode, description: Option<&str>) -> Self {
        Self {
            error: error.as_ref().to_string(),
            error_description: description.map(str::to_string),
        }
    }
}

/// Body returned to the Owner UI when it loads an authorization-code consent
/// prompt — describes the client, scopes, and any pre-approved subset.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OAuthConsent {
    pub(crate) id: String,
    pub(crate) client_id: String,
    /// The client's registered display name, so the consent UI can name the
    /// app instead of showing a raw `client_id`. Falls back to the
    /// `client_id` when the registration lookup misses.
    pub(crate) client_name: String,
    pub(crate) scopes: Vec<String>,
    pub(crate) redirect_uri: url::Url,
    pub(crate) pre_approved_scopes: Vec<String>,
    pub(crate) patient: Option<String>,
}

/// Body returned to the Owner UI when it loads a pending device-code consent
/// prompt — describes the requesting client, the device's chosen name, its
/// requested scopes, and the client's full allowed-scope set (the *expansion
/// envelope* the approver may grant up to, since device consent is expandable).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceConsent {
    pub(crate) user_code: String,
    pub(crate) client_id: String,
    pub(crate) client_name: String,
    pub(crate) device_name: Option<String>,
    pub(crate) requested_scopes: Vec<String>,
    pub(crate) allowed_scopes: Vec<String>,
}

/// Body posted by the Owner UI to approve a consent prompt: the scopes the
/// Owner ticked, plus an optional patient context to bind to the grant. The
/// device flow sends no `patient` today, so it deserializes to `None`; the
/// field is shared in anticipation of device-flow patient selection.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApproveBody {
    pub(crate) approved_scopes: Vec<String>,
    pub(crate) patient: Option<String>,
    /// An optional adjusted device name (device flow only — the settings approver
    /// renaming the device before approving). `None` on the code-flow path and
    /// when the approver didn't change it; `COALESCE`d server-side so the stored
    /// name is preserved.
    #[serde(default)]
    pub(crate) device_name: Option<String>,
}

/// Result the Owner UI sees after approving or denying a consent prompt.
///
/// A code-flow approval carries the client callback URL (`code` + `state`
/// appended to the client's `redirect_uri`) so the approving surface can
/// complete the flow directly when the approver *is* the requesting client —
/// no separate poll of `/oauth/authorize/{id}` needed. Device-flow approvals
/// have no client `redirect_uri`, so `redirect` is `None` and (thanks to
/// `skip_serializing_if`) omitted from the wire entirely.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub(crate) enum ConsentResult {
    Approved {
        #[serde(skip_serializing_if = "Option::is_none")]
        redirect: Option<String>,
    },
    Denied,
}
