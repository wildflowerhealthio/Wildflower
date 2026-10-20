//! `GET /oauth/authorize/{id}/session-shortfall`,
//! `POST /oauth/authorize/{id}/continue` and `POST /oauth/authorize/{id}/cancel`
//! — what the limited page (`GET /oauth/authorize/{id}/limited`, an
//! authorization page) calls on its own origin for a request whose browser
//! session holds less than the request asks for: read what the session lacks,
//! then go on or cancel.
//!
//! Each answers only the browser session the request was made in, read from
//! its `__Host-browser_session` cookie as the status poll reads it; any other
//! browser, with another session or none, gets the same `404` as an unknown
//! id. The two posts carry no body, so another page could send them as a
//! simple request; what refuses one is the host's cookie→bearer layer, which
//! answers `403` to a write carrying the cookie from anywhere but the server's
//! origin. Every answer is uncached: a Continue may carry the client callback
//! with a code.

use axum::extract::Path;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::Utc;
use serde::Serialize;
use utoipa::ToSchema;
use wildflowerhealthio_scope_capabilities::GrantedScopes as _;

use super::authorize::{next_step_location, AuthorizeError};
use super::openapi::AuthorizationRequestNotFound;
use super::OAUTH_MOUNT;
use crate::crypto_util::random_token::generate_authorization_code;
use crate::domain::access_token::VerifiedClaims;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::oauth::{
    AuthorizationStartError, PollingBrowserSession, SessionShortfallView,
};
use crate::http::browser_session_cookie::carried_browser_session;
use crate::http::extractors::Live;
use crate::http::wire_representations::CacheSuppressed;
use crate::live_bindings::{LiveCodeAuthorizationStarter, LiveSessionShortfall, LiveTokenVerifier};

/// What the limited page says: the app, and the scopes this browser's session
/// lacks of what the app asked for.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionShortfallBody {
    /// The app's registered name, or its `client_id` when it has none yet.
    client_name: String,
    /// The requested scopes, as the app asked for them, that a code issued in
    /// this browser's session would not carry in full, in the request's order.
    missing_scopes: Vec<String>,
}

impl From<SessionShortfallView> for SessionShortfallBody {
    fn from(view: SessionShortfallView) -> Self {
        SessionShortfallBody {
            client_name: view.client_name,
            missing_scopes: view.missing_scopes,
        }
    }
}

/// Where the limited page sends the browser next.
#[derive(Debug, Serialize, ToSchema)]
pub(super) struct SessionShortfallNextBody {
    /// The client callback (with a code, or with `error=access_denied`), or a
    /// path on this server: the consent card or the wait page.
    location: String,
}

/// The browser session `headers` carry, and its `sid`, as the limited page's
/// calls are answered in it; the `404` an unknown request `id` gets when they
/// carry none.
fn requesting_browser_session(
    token_verifier: &LiveTokenVerifier,
    headers: &HeaderMap,
    id: &str,
) -> Result<(VerifiedClaims, String), AuthorizationServerError> {
    let not_found = || AuthorizationServerError::AuthorizationRequestNotFound { id: id.to_owned() };
    let claims = carried_browser_session(token_verifier, headers)
        .map_err(|error| {
            AuthorizationServerError::infrastructure(
                "verify a browser session at the limited page",
                error,
            )
        })?
        .ok_or_else(not_found)?;
    let sid = claims.sid.clone().ok_or_else(not_found)?;
    Ok((claims, sid))
}

/// `location`, as the limited page's next stop, uncached.
fn next_location(location: String) -> Response {
    CacheSuppressed(Json(SessionShortfallNextBody { location })).into_response()
}

/// What this browser's session lacks of request `id`, and the app asking.
#[utoipa::path(
    get,
    tag = "OAuth 2.0",
    path = "/authorize/{id}/session-shortfall",
    params(("id" = String, Path, description = "Authorization request id")),
    responses(
        (status = 200, description = "The app and the scopes this browser's session lacks", body = SessionShortfallBody),
        (status = 404, description = "No request with that id waits on this browser's limited page", body = AuthorizationRequestNotFound)
    )
)]
pub(super) async fn handle_session_shortfall_read(
    session_shortfall: Live<LiveSessionShortfall>,
    token_verifier: Live<LiveTokenVerifier>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, AuthorizationServerError> {
    let (claims, sid) = requesting_browser_session(&token_verifier, &headers, &id)?;
    let browser_session = PollingBrowserSession {
        sid,
        grant: claims.granted(),
    };
    let view = session_shortfall.read(&id, &browser_session, Utc::now())?;
    Ok(CacheSuppressed(Json(SessionShortfallBody::from(view))).into_response())
}

/// Go on with request `id` although this browser's session holds less than it
/// asks for: issue a code under a standing grant that covers it, or else ask
/// the Owner, on the consent card when this browser can decide it and on the
/// wait page otherwise, with the request's five minutes started again. The
/// request spent from the authorization start limit when `/oauth/authorize`
/// parked it, so going on spends nothing. This browser session's later
/// requests for the same app skip the limited page. A client disabled since
/// the request parked ends it: the request is denied and the app is sent
/// `access_denied`.
#[utoipa::path(
    post,
    tag = "OAuth 2.0",
    path = "/authorize/{id}/continue",
    params(("id" = String, Path, description = "Authorization request id")),
    responses(
        (status = 200, description = "Where the browser goes next: the client callback (with a code, or with error=access_denied when the client was disabled since), the consent card or the wait page", body = SessionShortfallNextBody),
        (status = 404, description = "No request with that id waits on this browser's limited page", body = AuthorizationRequestNotFound),
        (status = 503, description = "No active signing key")
    )
)]
pub(super) async fn handle_session_shortfall_continue(
    code_authorization_starter: Live<LiveCodeAuthorizationStarter>,
    token_verifier: Live<LiveTokenVerifier>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, AuthorizationServerError> {
    let (_, sid) = requesting_browser_session(&token_verifier, &headers, &id)?;
    let next_step = code_authorization_starter.continue_past_session_shortfall(
        &id,
        &sid,
        generate_authorization_code(),
        Utc::now(),
    );
    let location = match next_step {
        Ok(next_step) => next_step_location(next_step, &format!("{OAUTH_MOUNT}/")),
        Err(AuthorizationStartError::Store(
            error @ AuthorizationServerError::AuthorizationRequestNotFound { .. },
        )) => return Err(error),
        // Cancelled between this Continue's acknowledgement and its fast-path
        // approval: no longer waiting here, like any other request that isn't.
        Err(AuthorizationStartError::RequestNotPending) => {
            return Err(AuthorizationServerError::AuthorizationRequestNotFound { id })
        }
        Err(error) => match AuthorizeError::from(error) {
            AuthorizeError::Redirect { location } => location,
            other => return Ok(other.into_response()),
        },
    };
    Ok(next_location(location))
}

/// Cancel request `id`: deny it and send the browser back to the app with
/// `error=access_denied`. Cancel isn't remembered: this session's next request
/// for the app stops at the limited page again.
#[utoipa::path(
    post,
    tag = "OAuth 2.0",
    path = "/authorize/{id}/cancel",
    params(("id" = String, Path, description = "Authorization request id")),
    responses(
        (status = 200, description = "The client callback carrying error=access_denied", body = SessionShortfallNextBody),
        (status = 404, description = "No request with that id waits on this browser's limited page", body = AuthorizationRequestNotFound)
    )
)]
pub(super) async fn handle_session_shortfall_cancel(
    session_shortfall: Live<LiveSessionShortfall>,
    token_verifier: Live<LiveTokenVerifier>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, AuthorizationServerError> {
    let (_, sid) = requesting_browser_session(&token_verifier, &headers, &id)?;
    let client_callback = session_shortfall.cancel(&id, &sid, Utc::now())?;
    Ok(next_location(client_callback))
}
