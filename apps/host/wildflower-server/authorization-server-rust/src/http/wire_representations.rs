//! Request/response wire shapes shared across the authorization server's route trees —
//! the JSON bodies the OAuth surface and the server's pages post and read. A
//! shape shared by two surfaces (e.g. [`ConsentResult`] across both consent
//! flows) has one home and the trees can't drift.
//!
//! Also home to [`CacheSuppressed`], the RFC 6749 §5.1/§5.2 cache-suppression
//! wrapper the token-surface responses, the authorize-status poll, and the
//! `/authorization` surface render through — a wire concern (headers on the response),
//! not route logic.

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
/// step a call site can forget. The same wrapper renders the authorize-status
/// poll (its `Approved` redirect carries a redeemable code), the start limit's
/// `429`, sign-out and, applied as a blanket layer, every Owner
/// `/authorization/*` response. The headers are inserted, not appended, so
/// nothing ends up with either twice.
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

/// RFC 6749 §5.1 successful token-endpoint response: what the token endpoint
/// gives an app for an authorization code, a refresh token or a device code.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct TokenResponse {
    /// The signed access token (a JWT) the app presents as its bearer.
    pub(crate) access_token: String,
    /// The access token's type: always `Bearer`.
    pub(crate) token_type: String,
    /// How many seconds the access token lives from issue.
    pub(crate) expires_in: i64,
    /// The scopes the access token holds, space-separated: the grant's, which
    /// may be narrower than the app asked for.
    pub(crate) scope: String,
    /// Present only when the grant carries [`wildflowerhealthio_scopes::KnownScope::OfflineAccess`]
    /// — the plaintext of the freshly-minted refresh-token generation (RFC 6749
    /// §5.1; only its hash is persisted).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) refresh_token: Option<String>,
    /// The SMART patient context: the FHIR `Patient` id the grant is bound
    /// to. Present only when the grant binds one.
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

/// RFC 6749 §5.2 error body: the token, revocation and device-authorization
/// endpoints, the wait page's status poll, and client authentication all
/// answer with it.
#[derive(Debug, Serialize, Deserialize, Clone, ToSchema)]
pub(crate) struct OAuthError {
    /// The standard error code, such as `invalid_request` or
    /// `invalid_client` (an [`OAuthErrorCode`]'s wire string).
    pub(crate) error: String,
    /// A sentence for the app's developer saying what was wrong; omitted when
    /// the code says enough.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error_description: Option<String>,
}

impl OAuthError {
    /// The body for `error`, with `description` as its `error_description`.
    /// Taking an [`OAuthErrorCode`] means a code outside the standard's list
    /// can't be written.
    pub(crate) fn new(error: OAuthErrorCode, description: Option<&str>) -> Self {
        Self {
            error: error.as_ref().to_string(),
            error_description: description.map(str::to_string),
        }
    }
}

/// Body the device page's consent card posts to
/// `POST /authorization/devices/{userCode}/approve` to approve a device-code
/// prompt or a browser pairing: the scopes the Owner ticked, plus an optional
/// patient context to bind to the grant, and an optional new name for the
/// device. The card pins a device grant to all patients, so it sends no
/// `patient` and the field deserializes to `None`.
///
/// The code flow posts its own
/// `ApproveOAuthConsentBody` instead — only that surface can show a
/// registration warning, and only its body carries the acknowledgement.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApproveBody {
    /// The scopes the approver ticked. They are clamped to what the prompt
    /// may grant and to the approver's own grant; a resource scope beyond the
    /// approver's grant is a `403`, and nothing left to grant is a deny.
    pub(crate) approved_scopes: Vec<String>,
    /// The FHIR `Patient` id to bind a device's grant to; `None` leaves it
    /// unbound. A pairing ignores it: a browser session binds no patient.
    pub(crate) patient: Option<String>,
    /// The approver's name for the device or browser, when they changed it
    /// before approving. A device's grant is named after it, else the
    /// device's own name; a pairing names the browser with it. `None` keeps
    /// the name the request carries rather than erasing it.
    #[serde(default)]
    pub(crate) device_name: Option<String>,
}

/// Result the approving surface sees after approving or denying a consent
/// prompt: `{"status":"approved"}` or `{"status":"denied"}`, with a
/// `redirect` for a code-flow decision.
///
/// A code-flow decision carries the client callback URL (`code` + `state`, or
/// `error=access_denied` + `state`, appended to the client's `redirect_uri`) so
/// the approving surface can complete the flow directly when it is the
/// requesting browser (the consent card) — no separate poll of
/// `/oauth/authorize/{id}` needed. Device-flow decisions have no client
/// `redirect_uri`, so `redirect` is `None` and (thanks to
/// `skip_serializing_if`) omitted from the wire entirely.
#[derive(Debug, Serialize, ToSchema)]
#[serde(tag = "status", rename_all = "lowercase")]
pub(crate) enum ConsentResult {
    /// The request was approved: a code-flow request's code is issued, a
    /// device's grant stands, a pairing's browser may now sign in.
    Approved {
        /// The app's callback carrying the code and the app's `state`, for
        /// the consent card to leave for; absent for a device-page decision,
        /// whose device or browser polls for its result.
        #[serde(skip_serializing_if = "Option::is_none")]
        #[schema(nullable = false)]
        redirect: Option<String>,
    },
    /// The request was denied: declined, or an approval that granted
    /// nothing. A code-flow approval is a deny too when the requesting
    /// browser's session has ended or the app was disabled since.
    Denied {
        /// The app's callback carrying `error=access_denied` and the app's
        /// `state`; absent for a device-page decision.
        #[serde(skip_serializing_if = "Option::is_none")]
        #[schema(nullable = false)]
        redirect: Option<String>,
    },
}

/// [`ConsentResult`] as a polled flow's decision answers it, for the spec: a
/// device's, a browser pairing's or a session widening's requester polls for
/// its result, so the decision carries no `redirect`. Only the spec reads it;
/// the routes render a [`ConsentResult`] with none.
#[derive(ToSchema)]
#[serde(tag = "status", rename_all = "lowercase")]
#[allow(dead_code)]
pub(crate) enum PolledConsentResult {
    /// The request was approved: a device's grant stands, a pairing's
    /// browser may now sign in, a widened session holds more.
    Approved,
    /// The request was denied: declined, or an approval that granted
    /// nothing.
    Denied,
}

/// A consent outcome on the launcher wire.
impl From<crate::domain::capabilities::ConsentOutcome> for ConsentResult {
    /// Render the domain consent action's [`ConsentOutcome`](crate::domain::capabilities::ConsentOutcome)
    /// onto the launcher wire result, so an approve/deny handler is
    /// `Ok(Json(outcome.into()))`.
    fn from(outcome: crate::domain::capabilities::ConsentOutcome) -> Self {
        match outcome {
            crate::domain::capabilities::ConsentOutcome::Approved { redirect } => {
                ConsentResult::Approved { redirect }
            }
            crate::domain::capabilities::ConsentOutcome::Denied { redirect } => {
                ConsentResult::Denied { redirect }
            }
        }
    }
}
