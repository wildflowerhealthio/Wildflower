//! `POST /oauth/authorize/{id}/ask-to-widen` and
//! `POST /oauth/session-widenings/{id}/poll` — the limited page's calls, on
//! its own origin, for a browser whose session holds less than an app's
//! request asks for: ask the Owner to widen the session by what it lacks, then
//! poll for the decision. The poll that finds the widening approved hands the
//! browser its wider session token as its `__Host-browser_session` cookie,
//! for the same session.
//!
//! Each answers only the browser session the request or widening was made
//! in, read from its cookie as the page's other calls read it; any other
//! browser gets the same `404` as an unknown id. Both are writes, so the
//! host's cookie→bearer layer refuses one carrying the cookie from anywhere
//! but the server's origin. Every answer is uncached: an approved poll carries
//! the session's cookie.

use axum::extract::Path;
use axum::http::{header, HeaderMap};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::Utc;
use serde::Serialize;
use utoipa::ToSchema;

use super::openapi::{AuthorizationRequestNotFound, SessionWideningNotFound};
use super::session_shortfall::requesting_browser_session;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::oauth::{SessionWideningPollError, SessionWideningStatus};
use crate::http::browser_session_cookie::carried_browser_session;
use crate::http::browser_session_set_cookie;
use crate::http::errors::InternalError;
use crate::http::extractors::Live;
use crate::http::middleware::StartLimitAskedNow;
use crate::http::wire_representations::CacheSuppressed;
use crate::live_bindings::{LiveSessionWidening, LiveTokenVerifier};

/// The widening an ask filed, which the page polls.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct AskedSessionWideningBody {
    /// The widening's id.
    widening_id: String,
}

/// Where a widening stands. `widened` carries the browser's wider session as
/// its `Set-Cookie`; the page then goes on with the app's request.
#[derive(Debug, Serialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(super) enum SessionWideningStatusBody {
    /// The Owner hasn't decided yet; the page polls again.
    Pending,
    /// The Owner declined: the session is as it was. No cookie is set.
    Declined,
    /// The Owner approved, and this poll collected the wider session: the
    /// response sets its token, for the same session, as the
    /// `__Host-browser_session` cookie, living until the session ends.
    Widened,
    /// The widening expired before the Owner decided, an earlier poll
    /// already collected it, or the session has ended. No cookie is set.
    Expired,
}

/// Ask the Owner to widen this browser's session by what it lacks of request
/// `id`, which waits on this browser's limited page, and raise the Owner's
/// notification. The widening asks for exactly what the session lacks of the
/// request, and the request keeps waiting on the page as long as the widening
/// waits for the Owner. It spends from the authorization start limit, as a
/// request raised for the Owner does, before anything else is read.
#[utoipa::path(
    post,
    tag = "OAuth 2.0",
    path = "/authorize/{id}/ask-to-widen",
    params(("id" = String, Path, description = "Authorization request id")),
    responses(
        (status = 200, description = "The widening filed for the Owner", body = AskedSessionWideningBody),
        (status = 404, description = "No request with that id waits on this browser's limited page, or this browser's session lacks nothing it could be widened by", body = AuthorizationRequestNotFound),
        (status = 429, description = "The authorization start limit refused the request")
    )
)]
pub(super) async fn handle_session_widening_ask(
    _start_limit: StartLimitAskedNow,
    session_widening: Live<LiveSessionWidening>,
    token_verifier: Live<LiveTokenVerifier>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, AuthorizationServerError> {
    let (_, sid) = requesting_browser_session(&token_verifier, &headers, &id)?;
    let widening_id = session_widening.ask(&id, &sid, Utc::now())?;
    Ok(CacheSuppressed(Json(AskedSessionWideningBody { widening_id })).into_response())
}

/// Poll the widening `id`, asked in this browser's session. The poll that
/// finds it approved collects the wider session: it sets the session's new
/// token as the browser's `__Host-browser_session` cookie and revokes the
/// token it replaces. A widening of another session's, or none, is a `404`; a
/// store failure, or a token that couldn't be minted, is a logged `500`.
#[utoipa::path(
    post,
    tag = "OAuth 2.0",
    path = "/session-widenings/{id}/poll",
    params(("id" = String, Path, description = "Session widening id")),
    responses(
        (status = 200, description = "Where the widening stands", body = SessionWideningStatusBody),
        (status = 404, description = "No widening asked in this browser's session has that id", body = SessionWideningNotFound)
    )
)]
pub(super) async fn handle_session_widening_poll(
    session_widening: Live<LiveSessionWidening>,
    token_verifier: Live<LiveTokenVerifier>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let presented_session = match carried_browser_session(&token_verifier, &headers) {
        Ok(Some(presented_session)) => presented_session,
        Ok(None) => {
            return CacheSuppressed(
                AuthorizationServerError::SessionWideningNotFound { id }.into_response(),
            )
            .into_response()
        }
        Err(error) => {
            return InternalError::new("verify a browser session at a widening's poll", error)
                .into_response()
        }
    };
    let response = match session_widening.poll(&id, &presented_session, Utc::now()) {
        Ok(SessionWideningStatus::Widened {
            session_token,
            session_ttl,
        }) => (
            [(
                header::SET_COOKIE,
                browser_session_set_cookie(&session_token, session_ttl),
            )],
            Json(SessionWideningStatusBody::Widened),
        )
            .into_response(),
        Ok(SessionWideningStatus::Pending) => {
            Json(SessionWideningStatusBody::Pending).into_response()
        }
        Ok(SessionWideningStatus::Declined) => {
            Json(SessionWideningStatusBody::Declined).into_response()
        }
        Ok(SessionWideningStatus::Expired) => {
            Json(SessionWideningStatusBody::Expired).into_response()
        }
        Err(SessionWideningPollError::Store(error)) => error.into_response(),
        Err(SessionWideningPollError::Issuance(error)) => {
            InternalError::new("mint a widened browser session's token", error).into_response()
        }
    };
    CacheSuppressed(response).into_response()
}
