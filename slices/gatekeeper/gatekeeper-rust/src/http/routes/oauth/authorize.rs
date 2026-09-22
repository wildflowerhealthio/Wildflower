use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use serde::Deserialize;
use utoipa::IntoParams;
use uuid::Uuid;

use crate::crypto_util::random_token::generate_authorization_code;
use crate::domain::capabilities::oauth::{
    AuthorizationStart, AuthorizationStartError, AuthorizeRequest, FreshIds,
};
use crate::domain::client_redirect::{build_client_error_redirect_url, build_client_redirect_url};
use crate::domain::page_paths;
use crate::http::errors::InternalError;
use crate::http::errors::{oauth_error_html, OAuthErrorKind};
use crate::http::state::GatekeeperState;
use crate::http::ServedOrigin;
use crate::live_bindings::LiveCodeAuthorizationStarter;

/// `302 Found` redirect. RFC 6749's examples use 302 and the TypeScript
/// implementation emits 302, so all `/oauth/authorize` redirects use it for
/// parity — axum's `Redirect` helpers only offer 303/307/308.
fn found_redirect(location: &str) -> Response {
    (
        StatusCode::FOUND,
        [(axum::http::header::LOCATION, location.to_string())],
    )
        .into_response()
}

/// Error half of the `/oauth/authorize` handler's `Result`. Each variant
/// renders one of the endpoint's three distinct failure shapes through
/// `IntoResponse`, so a fallible step bails with `?` instead of a `match` +
/// `return` at every call site — the authorization-endpoint analogue of
/// [`TokenError`](super::internal::TokenError) (and, on the Owner `/access`
/// surface, [`GatekeeperError`](crate::domain::gatekeeper_error::GatekeeperError)).
/// Kept small (no embedded
/// `Response`) so `Result<_, AuthorizeError>` doesn't trip
/// `clippy::result_large_err`.
pub(super) enum AuthorizeError {
    /// A failure on a request whose `redirect_uri` is not trusted — a disabled
    /// client, a malformed or non-http(s) URI, an unregistered redirect for the
    /// first-party client, or (because the client is new to this gatekeeper or
    /// the redirect is not on its registration) any later validation failure.
    /// Renders a local HTML page — redirecting to an unvouched-for URI would be
    /// an open redirect (RFC 6749 §4.1.2.1).
    LocalPage(OAuthErrorKind),
    /// A spec'd error once `redirect_uri` is validated — 302 back to the
    /// client. Carries the already-built `Location` (the client `redirect_uri`
    /// merged with `error` + `state`, RFC 6749 §4.1.2.1) rather than the `Url`,
    /// keeping the variant small enough to dodge `clippy::result_large_err`.
    Redirect { location: String },
    /// No active signing key: without token-mint capability the endpoint can't
    /// proceed, so it 503s rather than parking a request it can never complete.
    ServiceUnavailable,
    /// A logged, opaque 500 (e.g. a store read failed) — see [`InternalError`].
    Internal(InternalError),
}

/// Render the flow's failure vocabulary onto the endpoint's three response
/// shapes: a local page while the redirect is untrusted, a 302 with `error` +
/// `state` back to a validated redirect (RFC 6749 §4.1.2.1), a 503 with no
/// signing key, and a logged opaque 500 for the rest.
impl From<AuthorizationStartError> for AuthorizeError {
    fn from(error: AuthorizationStartError) -> Self {
        match error {
            AuthorizationStartError::NoActiveSigningKey => AuthorizeError::ServiceUnavailable,
            AuthorizationStartError::LocalPage(kind) => {
                if kind == OAuthErrorKind::RedirectUriNotAllowed {
                    tracing::warn!("redirect_uri not allowed for the first-party client");
                }
                AuthorizeError::LocalPage(kind)
            }
            AuthorizationStartError::Redirectable {
                redirect_uri,
                error,
                client_state,
            } => AuthorizeError::Redirect {
                location: build_client_error_redirect_url(&redirect_uri, error, &client_state),
            },
            AuthorizationStartError::RequestNotPending => {
                AuthorizeError::Internal(InternalError::new(
                    "approve_authorization_request",
                    "authorization request was not pending",
                ))
            }
            AuthorizationStartError::Store(error) => AuthorizeError::Internal(InternalError::new(
                "store operation failed at /oauth/authorize",
                error,
            )),
        }
    }
}

impl IntoResponse for AuthorizeError {
    fn into_response(self) -> Response {
        match self {
            AuthorizeError::LocalPage(kind) => html_bad_request(oauth_error_html(&kind)),
            AuthorizeError::Redirect { location } => found_redirect(&location),
            AuthorizeError::ServiceUnavailable => StatusCode::SERVICE_UNAVAILABLE.into_response(),
            AuthorizeError::Internal(error) => error.into_response(),
        }
    }
}

/// Query parameters accepted at `/oauth/authorize` per RFC 6749 §4.1.1 +
/// RFC 7636 (PKCE). Stricter than the base spec: `state` is required (the
/// spec merely recommends it), and PKCE with S256 is mandatory — both
/// matching the OAuth 2.1 direction. The optional SMART App Launch extensions
/// (`launch`, `aud`) are documented on their fields below.
#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct AuthorizeParams {
    pub response_type: String,
    pub code_challenge_method: String,
    pub client_id: String,
    pub scope: String,
    pub code_challenge: String,
    pub redirect_uri: String,
    pub state: String,
    /// SMART App Launch nonce, set by the EHR (apps-rust generates it,
    /// the SMART app forwards it). Not currently looked up against a
    /// launch-context table — we trust whatever value the SMART app
    /// echoes back and bind patient context at consent instead. Binding it
    /// (single-use, patient-bound) is tracked in
    /// <https://github.com/Assessment-is/Wildflower/issues/257>.
    #[serde(default)]
    pub launch: Option<String>,
    /// SMART App Launch audience hint: the FHIR base URL the SMART app
    /// expects to call with the resulting token. Not currently validated
    /// against [`shared_structures_rust::CANONICAL_ISSUER`] — `aud`
    /// binding in minted tokens is per-request via `served_base_url_for`.
    /// Validating it is tracked in
    /// <https://github.com/Assessment-is/Wildflower/issues/257>.
    #[serde(default)]
    pub aud: Option<String>,
}

/// The authorization endpoint (RFC 6749 §3.1), the public front door of the
/// OAuth flow. Validates the request, then either auto-issues an authorization
/// code (when an existing grant pre-approves every requested scope) or
/// redirects the user-agent to the Owner UI to drive the approval.
///
/// Nothing in-process calls this route. Registered clients (e.g.
/// SMART-on-FHIR apps) discover it via the FHIR server's
/// `.well-known/smart-configuration` (`authorization_endpoint`) and send the
/// *user's browser* here with PKCE params to start an authorization-code
/// flow:
///
/// 1. Browser lands here; the request is parked as an `AuthorizationRequest`
///    (5-minute TTL).
/// 2. Unless every requested scope is pre-approved by an existing grant for
///    this (client, `redirect_uri`) pair, the request joins the pending-consent
///    queue (raising the host webview's popup) and the browser is 302'd to the
///    Owner UI's polling page, which polls `GET /oauth/authorize/{id}` (a custom
///    extension, not part of any RFC) until the Owner decides — on that page if
///    the viewer is signed in, in the popup otherwise. RFC 6749
///    leaves the owner-interaction mechanism unspecified, so the polling
///    page is spec-legal; likewise §4.1 explicitly allows skipping consent
///    on a previously established authorization decision, which is what the
///    grant fast path implements.
/// 3. Approval 302s the browser back to the client's `redirect_uri` with
///    `code` + `state` (§4.1.2); the client then redeems the short-lived
///    code at `POST /oauth/token` (§4.1.3) with its PKCE verifier.
///
/// Clients other than the first-party host are **trusted on first use**: an
/// unknown `client_id`, an unregistered `redirect_uri`, and scopes outside the
/// registration are all carried to the Owner's prompt as a registration warning
/// rather than rejected here, and nothing is written to the `clients` table
/// until the Owner approves. Such a request never takes the grant fast path,
/// and while its redirect is untrusted every other failure renders the local
/// HTML page instead of redirecting. `wildflower-host` keeps the strict
/// treatment, and a disabled client is rejected either way.
#[utoipa::path(
    get,
    tag = "OAuth 2.0",
    path = "/authorize",
    params(AuthorizeParams),
    responses(
        (status = 302, description = "Redirect to the client redirect_uri or the owner approval UI"),
        (status = 400, description = "Local HTML error page (untrusted redirect_uri)"),
        (status = 503, description = "No active signing key")
    )
)]
pub(super) async fn handle_authorize_request(
    State(state): State<Arc<GatekeeperState>>,
    origin: ServedOrigin,
    Query(params): Query<AuthorizeParams>,
) -> Result<Response, AuthorizeError> {
    // Log the SMART App Launch params (see the `launch` / `aud` field docs) so
    // an operator can correlate a SMART app's request back to the click that
    // triggered it.
    if params.launch.is_some() || params.aud.is_some() {
        tracing::info!(
            client_id = %params.client_id,
            launch = ?params.launch,
            aud = ?params.aud,
            "SMART App Launch parameters received at /oauth/authorize",
        );
    }
    let started = LiveCodeAuthorizationStarter::from_state(&state).start(
        &AuthorizeRequest {
            response_type: &params.response_type,
            code_challenge_method: &params.code_challenge_method,
            client_id: &params.client_id,
            scope: &params.scope,
            code_challenge: &params.code_challenge,
            redirect_uri: &params.redirect_uri,
            client_state: &params.state,
        },
        &origin,
        FreshIds {
            request_id: Uuid::new_v4().to_string(),
            code: generate_authorization_code(),
        },
        chrono::Utc::now(),
    )?;
    Ok(match started {
        // Fully pre-approved: 302 the user-agent straight back to the client
        // with the fresh code (RFC 6749 §4.1.2).
        AuthorizationStart::RedirectToClient {
            redirect_uri,
            code,
            client_state,
        } => found_redirect(&build_client_redirect_url(
            &redirect_uri,
            &code,
            &client_state,
        )),
        // Otherwise the Owner UI's polling page, which waits for whichever
        // surface — its inline consent or the host popup — decides first.
        AuthorizationStart::AwaitOwner { request_id } => {
            found_redirect(&page_paths::oauth_polling_url(&origin, &request_id))
        }
    })
}

fn html_bad_request(html: String) -> Response {
    (StatusCode::BAD_REQUEST, Html(html)).into_response()
}
