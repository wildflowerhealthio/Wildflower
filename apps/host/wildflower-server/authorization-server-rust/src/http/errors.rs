//! Error **wire-representations** for the authorization server's routes and middleware —
//! how failures render onto the wire, and nothing else. The failure
//! *vocabulary* is domain ([`crate::domain::authorization_server_error::AuthorizationServerError`]); this
//! file only renders it — a typed `404` or `409` JSON body, the shared
//! insufficient-scope `403`, or a logged opaque `500` for an
//! [`Infrastructure`](AuthorizationServerError::Infrastructure) failure — so a route
//! bails with `?` and its `Result` becomes a response with no HTTP glue at the
//! call site. Two rules run through it: a server-side failure is an opaque
//! `500` whose detail goes to the operator's log, never the caller; and a
//! refused credential is a bare `401` that names why only for the host's
//! request log.
//!
//! Also holds the canned response shapes the middleware produces directly
//! (a logged 500 via [`internal_error`], a plain 401 via [`unauthorized`]
//! stamped with its [`RequestRefusal`],
//! the [`verify_error_response`] status mapping for token verification), and the
//! local HTML error pages the `/oauth/authorize` endpoint renders for failures
//! that may NOT be redirected back to the client (RFC 6749 §4.1.2.1 restricts
//! those to `redirect_uri`/`client_id` validation failures — every other spec'd
//! error is delivered by redirecting to the already-validated `redirect_uri`),
//! and the page `/oauth/sign-in` renders when it refuses a browser.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use utoipa::ToSchema;
use wildflowerhealthio_shared_structures::request_caller::RequestRefusal;

use crate::domain::access_token::AccessTokenVerifyError;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::oauth::SignInRefusal;

/// Map a token-[`AccessTokenVerifyError`] to its HTTP response, shared by the auth
/// middlewares. Server-side failures (no keys configured, the key, revocation
/// or browser-session store can't be read, a configured key's material is
/// corrupt) are operator problems, so
/// they log and return 500; only a genuinely rejected or revoked token is a
/// 401, stamped with the matching [`RequestRefusal`]. Written as an exhaustive
/// match so a new `AccessTokenVerifyError` variant forces a deliberate status choice
/// rather than silently defaulting to 401.
pub(crate) fn verify_error_response(context: &str, err: AccessTokenVerifyError) -> Response {
    match err {
        AccessTokenVerifyError::NoSigningKeysConfigured
        | AccessTokenVerifyError::KeyStoreUnavailable(_)
        | AccessTokenVerifyError::RevocationStoreUnavailable(_)
        | AccessTokenVerifyError::BrowserSessionStoreUnavailable(_)
        | AccessTokenVerifyError::SigningKeyUnreadable(_) => internal_error(context, err),
        AccessTokenVerifyError::TokenRejected => unauthorized(RequestRefusal::TokenRejected),
        AccessTokenVerifyError::Revoked => unauthorized(RequestRefusal::Revoked),
    }
}

/// Log `err` against `context` at error level and return an opaque 500. The
/// body is intentionally empty — the detail goes to the operator's logs, not
/// the client.
pub(crate) fn internal_error(context: &str, err: impl std::fmt::Display) -> Response {
    tracing::error!(error = %err, "{context}");
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}

/// The "a server-side step failed" payload shared by the OAuth surfaces'
/// error enums (`TokenError` and `AuthorizeError`): an operator-facing `context`
/// and the `source` detail, logged + returned as an opaque 500. (The `/authorization`
/// surface renders the same opaque 500 through
/// [`AuthorizationServerError::Infrastructure`](crate::domain::authorization_server_error::AuthorizationServerError::Infrastructure),
/// which builds an `InternalError` at render time rather than holding one.) This
/// is the shared type from `shared-structures-rust` — the same one the other
/// `-rust` slices hold in their `Internal` variant — re-exported
/// here so the OAuth surfaces keep importing it from `errors`. Each
/// enum holds it in its `Internal` variant instead of re-declaring the same
/// fields, constructor, and render call. (`TokenError` additionally
/// cache-suppresses the rendered 500 per RFC 6749 §5.1 by wrapping it.)
pub(crate) use wildflowerhealthio_shared_structures::http_errors::InternalError;

/// Bare 401 used by the auth middleware when a request lacks a valid bearer
/// token, stamped with `refusal` (why it lacks one) for the forwarded-request
/// report (see `wildflowerhealthio_shared_structures::request_caller`).
///
/// No body, as the clients' `HttpApiError.Unauthorized` declares it: a body
/// that isn't JSON fails their decode, and the page sees a parse error
/// instead of a `401`.
pub(crate) fn unauthorized(refusal: RequestRefusal) -> Response {
    let mut response = StatusCode::UNAUTHORIZED.into_response();
    response.extensions_mut().insert(refusal);
    response
}

/// A `403 Forbidden` carrying the rendered scopes the caller lacks. Two
/// [`AuthorizationServerError`] variants render through it:
/// [`InsufficientScope`](AuthorizationServerError::InsufficientScope), the scope-gated
/// capability extractor's rejection when a token doesn't cover a capability's
/// required scope, and
/// [`InsufficientApproverScope`](AuthorizationServerError::InsufficientApproverScope),
/// when an approver tries to delegate scopes beyond their own grant. This is the
/// authorization (not authentication) failure path: the `403` the authorization
/// server's `/authorization` surface returns.
/// The wire shape and this constructor live in `scope-capabilities-rust` (the
/// reusable capability layer), re-exported here so call sites keep importing it
/// from `errors`.
pub(crate) use wildflowerhealthio_scope_capabilities::insufficient_scope;

/// Wire shape for `GrantNotFound` (404) — no standing grant has this id.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct GrantNotFoundBody {
    /// Always `"GrantNotFound"`.
    pub(crate) error: &'static str,
    /// The grant id the caller asked for.
    pub(crate) id: String,
}

/// Wire shape for `BrowserSessionNotFound` (404) — no standing browser
/// session has this `sid`.
#[derive(Debug, Serialize)]
pub(crate) struct BrowserSessionNotFoundBody {
    /// Always `"BrowserSessionNotFound"`.
    pub(crate) error: &'static str,
    /// The session id the caller asked for: unknown, or already revoked.
    pub(crate) sid: String,
}

/// Wire shape for `ClientNotFound` (404) — no registered client has this
/// `client_id`.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientNotFoundBody {
    /// Always `"ClientNotFound"`.
    pub(crate) error: &'static str,
    /// The `client_id` the caller asked for.
    pub(crate) client_id: String,
}

/// Wire shape for `EssentialClient` (409) — the named client is essential:
/// disabling it would leave the Owner no way in.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EssentialClientBody {
    /// Always `"EssentialClient"`.
    pub(crate) error: &'static str,
    /// The essential client the caller tried to disable: the host app's or
    /// the browser-session client.
    pub(crate) client_id: String,
}

/// Wire shape for `OAuthConsentNotFound` (404) — no pending authorization-code
/// consent has this id.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct OAuthConsentNotFoundBody {
    /// Always `"OAuthConsentNotFound"`.
    pub(crate) error: &'static str,
    /// The request id the caller asked for: unknown, decided, expired, still
    /// waiting on its browser's limited page, or for a client disabled since.
    pub(crate) id: String,
}

/// Wire shape for `RegistrationNotAcknowledged` (409) — the approval named a
/// client, redirect, or scope outside the current registration and did not carry
/// the Owner's acknowledgement.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct RegistrationNotAcknowledgedBody {
    /// Always `"RegistrationNotAcknowledged"`.
    pub(crate) error: &'static str,
    /// The id of the request whose approval was refused; nothing was written.
    pub(crate) id: String,
}

/// Wire shape for `LaunchPatientMismatch` (409) — the approval named a patient
/// other than the one the request's SMART launch binds.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct LaunchPatientMismatchBody {
    /// Always `"LaunchPatientMismatch"`.
    pub(crate) error: &'static str,
    /// The id of the request whose approval was refused; nothing was written.
    pub(crate) id: String,
}

/// Wire shape for `DeviceConsentNotFound` (404) — no pending device-code consent
/// has this user code. Keyed by `userCode`, unlike the id-keyed siblings.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct DeviceConsentNotFoundBody {
    /// Always `"DeviceConsentNotFound"`.
    pub(crate) error: &'static str,
    /// The user code the caller asked for: unknown, decided or expired, or a
    /// code-flow request's, which the device page never shows.
    #[serde(rename = "userCode")]
    pub(crate) user_code: String,
}

/// Wire shape for `AuthorizationRequestNotFound` (404) — no authorization request
/// has this id.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct AuthorizationRequestNotFoundBody {
    /// Always `"AuthorizationRequestNotFound"`.
    pub(crate) error: &'static str,
    /// The request id the caller asked for.
    pub(crate) id: String,
}

/// Wire shape for `SessionWideningNotFound` (404) — no session widening the
/// caller may see has this id.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct SessionWideningNotFoundBody {
    /// Always `"SessionWideningNotFound"`.
    pub(crate) error: &'static str,
    /// The widening id the caller asked for: unknown, decided or expired for
    /// the Owner's card; another session's for the limited page's poll.
    pub(crate) id: String,
}

/// The `/authorization` surface's failures as HTTP responses.
impl IntoResponse for AuthorizationServerError {
    /// Render the domain's failure vocabulary onto the wire, the same way from
    /// every `/authorization` route. Every JSON body carries `error`, the
    /// variant's name, and one key, the identifier the caller sent:
    ///
    /// - each `*NotFound` variant is a `404` naming what wasn't found: `id` for an
    ///   OAuth consent, an authorization request, a session widening or a
    ///   grant, `userCode` for a
    ///   device consent, `sid` for a browser session, `clientId` for a client;
    /// - a refusal of an otherwise valid request is a `409` of the same shape:
    ///   `EssentialClient` (`clientId`), a request to disable a client the Owner
    ///   needs to get in; `RegistrationNotAcknowledged` (`id`), an approval
    ///   outside the app's registration without the Owner's acknowledgement; and
    ///   `LaunchPatientMismatch` (`id`), an approval naming a patient other than
    ///   the one the app's launch binds;
    /// - a missing scope, the caller's (`InsufficientScope`) or on an approval the
    ///   approver's (`InsufficientApproverScope`), is the shared `403` listing the
    ///   scopes lacking;
    /// - an [`Infrastructure`](AuthorizationServerError::Infrastructure) failure is
    ///   logged (via the shared [`InternalError`]) and answered as an opaque, empty
    ///   `500`.
    ///
    /// This is the whole of the HTTP layer's error knowledge for the
    /// `/authorization` surface; the handlers just `?` a
    /// `Result<_, AuthorizationServerError>` from a domain action.
    fn into_response(self) -> Response {
        match self {
            AuthorizationServerError::OAuthConsentNotFound { id } => (
                StatusCode::NOT_FOUND,
                Json(OAuthConsentNotFoundBody {
                    error: "OAuthConsentNotFound",
                    id,
                }),
            )
                .into_response(),
            AuthorizationServerError::DeviceConsentNotFound { user_code } => (
                StatusCode::NOT_FOUND,
                Json(DeviceConsentNotFoundBody {
                    error: "DeviceConsentNotFound",
                    user_code,
                }),
            )
                .into_response(),
            AuthorizationServerError::GrantNotFound { id } => (
                StatusCode::NOT_FOUND,
                Json(GrantNotFoundBody {
                    error: "GrantNotFound",
                    id,
                }),
            )
                .into_response(),
            AuthorizationServerError::BrowserSessionNotFound { sid } => (
                StatusCode::NOT_FOUND,
                Json(BrowserSessionNotFoundBody {
                    error: "BrowserSessionNotFound",
                    sid,
                }),
            )
                .into_response(),
            AuthorizationServerError::ClientNotFound { client_id } => (
                StatusCode::NOT_FOUND,
                Json(ClientNotFoundBody {
                    error: "ClientNotFound",
                    client_id,
                }),
            )
                .into_response(),
            AuthorizationServerError::EssentialClient { client_id } => (
                StatusCode::CONFLICT,
                Json(EssentialClientBody {
                    error: "EssentialClient",
                    client_id,
                }),
            )
                .into_response(),
            AuthorizationServerError::AuthorizationRequestNotFound { id } => (
                StatusCode::NOT_FOUND,
                Json(AuthorizationRequestNotFoundBody {
                    error: "AuthorizationRequestNotFound",
                    id,
                }),
            )
                .into_response(),
            AuthorizationServerError::SessionWideningNotFound { id } => (
                StatusCode::NOT_FOUND,
                Json(SessionWideningNotFoundBody {
                    error: "SessionWideningNotFound",
                    id,
                }),
            )
                .into_response(),
            AuthorizationServerError::RegistrationNotAcknowledged { id } => (
                StatusCode::CONFLICT,
                Json(RegistrationNotAcknowledgedBody {
                    error: "RegistrationNotAcknowledged",
                    id,
                }),
            )
                .into_response(),
            AuthorizationServerError::LaunchPatientMismatch { id } => (
                StatusCode::CONFLICT,
                Json(LaunchPatientMismatchBody {
                    error: "LaunchPatientMismatch",
                    id,
                }),
            )
                .into_response(),
            AuthorizationServerError::InsufficientScope { missing_scopes } => {
                insufficient_scope(missing_scopes)
            }
            AuthorizationServerError::InsufficientApproverScope {
                approver_missing_scopes,
            } => insufficient_scope(approver_missing_scopes),
            AuthorizationServerError::Infrastructure { context, source } => {
                InternalError::new(context, source).into_response()
            }
        }
    }
}

pub(crate) use crate::domain::authorize_refusal::AuthorizeRefusal;

/// The local page's title for `kind`; its body is [`AuthorizeRefusal::description`].
fn title(kind: AuthorizeRefusal) -> &'static str {
    match kind {
        AuthorizeRefusal::InvalidRedirectUri => "Invalid redirect URI",
        AuthorizeRefusal::InvalidScheme => "Invalid redirect URI scheme",
        AuthorizeRefusal::DisabledClient => "Disabled client",
        AuthorizeRefusal::RedirectUriNotAllowed => "Redirect URI not allowed",
        AuthorizeRefusal::UnsupportedResponseType => "Unsupported response type",
        AuthorizeRefusal::UnsupportedCodeChallengeMethod => "Unsupported PKCE method",
        AuthorizeRefusal::InvalidCodeChallenge => "Invalid PKCE code challenge",
        AuthorizeRefusal::LaunchUnknown => "Launch not recognized",
        AuthorizeRefusal::LaunchAlreadyUsed => "Launch already used",
        AuthorizeRefusal::LaunchExpired => "Launch expired",
        AuthorizeRefusal::InvalidAudience => "Wrong server",
    }
}

/// The local page `/oauth/authorize` renders for a refusal it may not redirect.
pub fn oauth_error_html(kind: AuthorizeRefusal) -> String {
    local_error_page(title(kind), kind.description())
}

/// The page `/oauth/sign-in` renders for a request it refuses.
pub(crate) fn sign_in_error_html(refusal: SignInRefusal) -> String {
    let (title, body) = match refusal {
        SignInRefusal::RedirectNotAllowed => (
            "Sign-in destination not allowed",
            "The sign-in link sends you somewhere this server doesn't send a browser.",
        ),
        SignInRefusal::CodeNotRedeemable => (
            "Sign-in link expired",
            "The sign-in link is unknown, already used, or expired. Sign in again from \
             the Wildflower app.",
        ),
        SignInRefusal::BrowserSessionClientDisabled => (
            "Browser sign-in disabled",
            "Browsers can't be signed in as the Owner while the Wildflower Browsers client \
             is disabled.",
        ),
    };
    local_error_page(title, body)
}

/// A local HTML error page: `title` as its title and heading, `body` beneath.
/// Both are fixed strings, never request input.
fn local_error_page(title: &str, body: &str) -> String {
    format!(
        "<!doctype html>\n\
<html lang=\"en\">\n\
<head>\n\
  <meta charset=\"utf-8\">\n\
  <title>{title}</title>\n\
</head>\n\
<body>\n\
  <h1>{title}</h1>\n\
  <p>{body}</p>\n\
</body>\n\
</html>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::signing_key::KeyMaterialError;

    // Server-side `AccessTokenVerifyError` variants are operator problems → 500; only a
    // rejected token is a 401. One test per variant so a failure names the
    // exact mapping that broke. The match in `verify_error_response` is
    // exhaustive, so a new variant is a compile error, not a silent 401.

    /// No signing keys is a `500`, and a `500` carries no refusal.
    #[test]
    fn no_signing_keys_configured_maps_to_500() {
        let response =
            verify_error_response("test", AccessTokenVerifyError::NoSigningKeysConfigured);
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(stamped_refusal(&response), None, "a 500 is not a refusal");
    }

    /// A key store that can't be read is a `500`.
    #[test]
    fn key_store_unavailable_maps_to_500() {
        let err =
            AccessTokenVerifyError::KeyStoreUnavailable(AuthorizationServerError::infrastructure(
                "all_signing_keys failed",
                "query returned no rows",
            ));
        let response = verify_error_response("test", err);
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    /// A stored key whose material won't decode is a `500`.
    #[test]
    fn signing_key_unreadable_maps_to_500() {
        let err = AccessTokenVerifyError::SigningKeyUnreadable(KeyMaterialError::Decode(
            base64::DecodeError::InvalidByte(0, b'!'),
        ));
        let response = verify_error_response("test", err);
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    /// The refusal stamped on `response` for the host's request log, if any.
    fn stamped_refusal(response: &Response) -> Option<RequestRefusal> {
        response.extensions().get::<RequestRefusal>().copied()
    }

    /// A `401` has an empty body, as the clients' decode expects.
    #[tokio::test]
    async fn a_401_has_no_body() {
        let response = unauthorized(RequestRefusal::MissingToken);
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read the body");
        assert!(body.is_empty(), "{body:?}");
    }

    /// A rejected token is a `401` stamped `TokenRejected`.
    #[test]
    fn token_rejected_maps_to_401() {
        let response = verify_error_response("test", AccessTokenVerifyError::TokenRejected);
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            stamped_refusal(&response),
            Some(RequestRefusal::TokenRejected)
        );
    }

    /// A revoked token is a `401` too, stamped `Revoked`.
    #[test]
    fn revoked_maps_to_401() {
        // A revoked-but-otherwise-valid token is a client problem, not an
        // operator one → 401, same as a plain rejection.
        let response = verify_error_response("test", AccessTokenVerifyError::Revoked);
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(stamped_refusal(&response), Some(RequestRefusal::Revoked));
    }

    /// A revocation store or a browser-session store that can't be read is a
    /// `500`: the server can't prove the token is live, so it neither admits
    /// nor blames the caller.
    #[test]
    fn revocation_store_unavailable_maps_to_500() {
        // A store read failure fails closed: we can't prove the token is live,
        // so it's an operator-facing 500, never a silent pass.
        let err =
            AccessTokenVerifyError::RevocationStoreUnavailable("query returned no rows".to_owned());
        let response = verify_error_response("test", err);
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let err = AccessTokenVerifyError::BrowserSessionStoreUnavailable(
            AuthorizationServerError::infrastructure("browser_session_by_sid failed", "locked"),
        );
        let response = verify_error_response("test", err);
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    /// A launch-bound patient mismatch is a `409` carrying the
    /// `LaunchPatientMismatch` tag and the consent id — the shape
    /// `authorization-core`'s `LaunchPatientMismatchSchema` decodes.
    #[tokio::test]
    async fn launch_patient_mismatch_maps_to_a_tagged_409() {
        let response = AuthorizationServerError::LaunchPatientMismatch {
            id: "consent-1".to_owned(),
        }
        .into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).expect("json"),
            serde_json::json!({ "error": "LaunchPatientMismatch", "id": "consent-1" }),
        );
    }
}
