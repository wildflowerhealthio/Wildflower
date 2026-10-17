use axum::extract::{OriginalUri, Query};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::Extension;
use serde::Deserialize;
use utoipa::IntoParams;
use uuid::Uuid;
use wildflowerhealthio_scope_capabilities::GrantedScopes;

use crate::crypto_util::random_token::generate_authorization_code;
use crate::domain::capabilities::oauth::{
    AuthorizationStartError, AuthorizeNextStep, AuthorizeRequest, FreshIds,
};
use crate::domain::client_redirect::{build_client_error_redirect_url, build_client_redirect_url};
use crate::http::browser_session_cookie::{can_decide_consents, carried_browser_session};
use crate::http::errors::InternalError;
use crate::http::errors::{oauth_error_html, OAuthErrorKind};
use crate::http::extractors::Live;
use crate::http::middleware::{start_limited_response, DeferredStartLimit};

use super::authorization_pages::{consent_page_location, pairing_page_location};
use super::wait_page::wait_page_location;
use crate::live_bindings::{LiveCodeAuthorizationStarter, LiveTokenVerifier};

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
/// [`TokenError`](super::internal::TokenError) (and, on the Owner `/authorization`
/// surface, [`AuthorizationServerError`](crate::domain::authorization_server_error::AuthorizationServerError)).
/// Kept small (no embedded
/// `Response`) so `Result<_, AuthorizeError>` doesn't trip
/// `clippy::result_large_err`.
pub(super) enum AuthorizeError {
    /// A failure on a request whose `redirect_uri` is not trusted — a disabled
    /// client, a malformed or non-http(s) URI, an unregistered redirect for the
    /// host app's client, or (because the client is new to this authorization server or
    /// the redirect is not on its registration) any later validation failure.
    /// Renders a local HTML page — redirecting to an unvouched-for URI would be
    /// an open redirect (RFC 6749 §4.1.2.1).
    LocalPage(OAuthErrorKind),
    /// A spec'd error once `redirect_uri` is validated — 302 back to the
    /// client. Carries the already-built `Location` (the client `redirect_uri`
    /// merged with `error` + `error_description` + `state`, RFC 6749
    /// §4.1.2.1) rather than the `Url`, keeping the variant small enough to
    /// dodge `clippy::result_large_err`.
    Redirect { location: String },
    /// No active signing key: without token-mint capability the endpoint can't
    /// proceed, so it 503s rather than parking a request it can never complete.
    ServiceUnavailable,
    /// The authorization start limit refused a request that would be raised
    /// for the Owner — the `429` the limit's layer answers.
    StartLimited,
    /// A logged, opaque 500 (e.g. a store read failed) — see [`InternalError`].
    Internal(InternalError),
}

/// Render the flow's failure vocabulary onto the endpoint's three response
/// shapes: a local page while the redirect is untrusted, a 302 with `error` +
/// `error_description` + `state` back to a validated redirect (RFC 6749
/// §4.1.2.1), a 503 with no signing key, and a logged opaque 500 for the rest.
impl From<AuthorizationStartError> for AuthorizeError {
    fn from(error: AuthorizationStartError) -> Self {
        match error {
            AuthorizationStartError::NoActiveSigningKey => AuthorizeError::ServiceUnavailable,
            AuthorizationStartError::StartLimited => AuthorizeError::StartLimited,
            AuthorizationStartError::LocalPage(kind) => {
                if kind == OAuthErrorKind::RedirectUriNotAllowed {
                    tracing::warn!("redirect_uri not allowed for the host app's client");
                }
                AuthorizeError::LocalPage(kind)
            }
            AuthorizationStartError::Redirectable {
                redirect_uri,
                error,
                description,
                client_state,
            } => AuthorizeError::Redirect {
                location: build_client_error_redirect_url(
                    &redirect_uri,
                    error,
                    description,
                    &client_state,
                ),
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
            AuthorizeError::LocalPage(kind) => html_bad_request(oauth_error_html(kind)),
            AuthorizeError::Redirect { location } => found_redirect(&location),
            AuthorizeError::ServiceUnavailable => StatusCode::SERVICE_UNAVAILABLE.into_response(),
            AuthorizeError::StartLimited => start_limited_response(),
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
    /// SMART App Launch `launch` value, handed to the app in its launch URL
    /// and forwarded here. It must name a launch this server minted for this
    /// `client_id` that is unused and unexpired (five minutes); it is consumed,
    /// so it works once, and the request carries the launch's context
    /// (including any patient it binds) to the consent. Any other value is
    /// `invalid_request`. A browser without a session is sent to pairing
    /// before the launch is read, so pairing never spends it. Absent, the
    /// request is plain OAuth.
    #[serde(default)]
    pub launch: Option<String>,
    /// SMART App Launch audience: the FHIR server the app expects to call with
    /// the token. When present it must be this server's origin
    /// (`https://<domain>`), which is also its FHIR base, else
    /// `invalid_request`. The minted token's `aud` is the server's origin.
    #[serde(default)]
    pub aud: Option<String>,
}

/// The authorization endpoint (RFC 6749 §3.1), the public front door of the
/// OAuth flow. It issues nothing to a browser without a browser session: such
/// a browser is sent to the pairing page first. For a browser with one it
/// validates the request, then either auto-issues an authorization code (when
/// an existing grant pre-approves every requested scope) or parks the
/// user-agent on the consent card or the wait page while the Owner decides.
///
/// Nothing in-process calls this route. Registered clients (e.g.
/// SMART-on-FHIR apps) discover it via the FHIR server's
/// `.well-known/smart-configuration` (`authorization_endpoint`) and send the
/// *user's browser* here with PKCE params to start an authorization-code
/// flow:
///
/// 1. Browser lands here. The browser session cookie is read before anything
///    else: a browser without a live browser session is 302'd to the pairing
///    page, `/oauth/pair?next=<this request's path and query>`, and nothing is
///    parked, notified or consumed. Once the Owner approves the pairing, the
///    page sends the browser back here with its new session. A browser with a
///    session has its request parked as an `AuthorizationRequest` (5-minute
///    TTL), made in that session (`sid`). A SMART App Launch's `aud` and
///    `launch` are checked first (see their fields), and the launch is
///    consumed onto the request.
/// 2. Unless every requested scope is pre-approved by an existing grant for
///    this (client, `redirect_uri`) pair, the request joins the pending-consent
///    queue and the browser is 302'd to a page this authorization server
///    serves beside the endpoint, on the origin the browser used. A browser
///    whose session can decide consents and holds the request's approval
///    scopes goes to the consent card at `/oauth/authorize/{id}/consent`, where
///    it decides in place; the request records that it can be decided there
///    (`decidable_in_requesting_browser`). Any other goes to the wait page at
///    `/oauth/authorize/{id}/wait`, and the Owner is notified (the host
///    webview's popup). The wait page polls `GET /oauth/authorize/{id}` (a
///    custom extension, not part of any RFC), which answers the browser
///    session the request was made in and a session that can decide it on
///    the consent card, until the Owner decides — in the
///    popup, in a signed-in launcher, or on the consent card once that
///    browser can decide it. Either way the code is issued under the session
///    the request was made in, not the approver's.
///    RFC 6749 leaves the owner-interaction mechanism unspecified, so both
///    pages are spec-legal; likewise §4.1 explicitly allows skipping consent
///    on a previously established authorization decision, which is what the
///    grant fast path implements.
/// 3. Approval 302s the browser back to the client's `redirect_uri` with
///    `code` + `state` (§4.1.2); the client then redeems the short-lived
///    code at `POST /oauth/token` (§4.1.3) with its PKCE verifier.
///
/// Clients other than the host app's are **trusted on first use**: an
/// unknown `client_id`, an unregistered `redirect_uri`, and scopes outside the
/// registration are all carried to the Owner's prompt as a registration warning
/// rather than rejected here, and nothing is written to the `clients` table
/// until the Owner approves. Such a request never takes the grant fast path,
/// and while its redirect is untrusted every other failure renders the local
/// HTML page instead of redirecting. The host app's client keeps the strict
/// treatment, and a disabled client is rejected either way.
#[utoipa::path(
    get,
    tag = "OAuth 2.0",
    path = "/authorize",
    params(AuthorizeParams),
    responses(
        (status = 302, description = "Redirect to the pairing page (a browser without a browser session), the client redirect_uri, or the authorization server's consent card (a session that can approve the request) or wait page"),
        (status = 400, description = "Local HTML error page (untrusted redirect_uri)"),
        (status = 429, description = "The authorization start limit refused the request"),
        (status = 503, description = "No active signing key")
    )
)]
pub(super) async fn handle_authorize_request(
    code_authorization_starter: Live<LiveCodeAuthorizationStarter>,
    token_verifier: Live<LiveTokenVerifier>,
    deferred_start_limit: Option<Extension<DeferredStartLimit>>,
    headers: HeaderMap,
    OriginalUri(authorize_uri): OriginalUri,
    Query(params): Query<AuthorizeParams>,
) -> Result<Response, AuthorizeError> {
    // The start limit's layer deferred it for a browser that can decide
    // consents: asked only if the request is raised for the Owner.
    let may_raise_for_owner = || {
        deferred_start_limit
            .as_ref()
            .is_none_or(|Extension(deferred_start_limit)| deferred_start_limit.admits())
    };
    let browser_session = carried_browser_session(&token_verifier, &headers).map_err(|error| {
        AuthorizeError::Internal(InternalError::new(
            "verify a browser session at /oauth/authorize",
            error,
        ))
    })?;
    // No browser session, no authorization: pair this browser first, then
    // come back to this very request. Nothing is parked, notified or consumed.
    let Some((browser_session, browser_sid)) = browser_session
        .as_ref()
        .and_then(|claims| Some((claims, claims.sid.as_deref()?)))
    else {
        return Ok(found_redirect(&pairing_page_location(
            authorize_uri
                .path_and_query()
                .map_or(authorize_uri.path(), |path_and_query| {
                    path_and_query.as_str()
                }),
        )));
    };
    let requesting_browser_grant =
        can_decide_consents(browser_session).then(|| browser_session.granted());
    let next_step = code_authorization_starter.start(
        &AuthorizeRequest {
            response_type: &params.response_type,
            code_challenge_method: &params.code_challenge_method,
            client_id: &params.client_id,
            scope: &params.scope,
            code_challenge: &params.code_challenge,
            redirect_uri: &params.redirect_uri,
            client_state: &params.state,
            launch: params.launch.as_deref(),
            aud: params.aud.as_deref(),
            requesting_browser_grant: requesting_browser_grant.as_ref(),
            may_raise_for_owner: &may_raise_for_owner,
            sid: browser_sid,
        },
        FreshIds {
            request_id: Uuid::new_v4().to_string(),
            code: generate_authorization_code(),
        },
        chrono::Utc::now(),
    )?;
    Ok(match next_step {
        // Fully pre-approved: 302 the user-agent straight back to the client
        // with the fresh code (RFC 6749 §4.1.2).
        AuthorizeNextStep::RedirectToClient {
            redirect_uri,
            code,
            client_state,
        } => found_redirect(&build_client_redirect_url(
            &redirect_uri,
            &code,
            &client_state,
        )),
        // Otherwise the Owner decides: on the consent card, when this browser
        // is signed in as the Owner, and else from this authorization server's
        // wait page, which waits for whichever surface — the host popup, a
        // signed-in launcher's consent list, or the consent card — decides
        // first.
        AuthorizeNextStep::AwaitOwner {
            request_id,
            decidable_in_requesting_browser,
        } => {
            if decidable_in_requesting_browser {
                found_redirect(&consent_page_location(&request_id))
            } else {
                found_redirect(&wait_page_location(&request_id))
            }
        }
    })
}

fn html_bad_request(html: String) -> Response {
    (StatusCode::BAD_REQUEST, Html(html)).into_response()
}
