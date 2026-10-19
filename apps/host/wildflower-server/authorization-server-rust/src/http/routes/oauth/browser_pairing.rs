//! `POST /oauth/pair/start` and `POST /oauth/pair/poll` — the endpoints the
//! pairing page (`GET /oauth/pair`, an authorization page) calls on its own
//! origin: start a browser pairing, then poll it until the Owner decides it.
//! The poll that finds it approved hands the browser its approved browser
//! session as its `__Host-browser_session` cookie.
//!
//! Pairing is no OAuth flow, so the bodies are JSON, not form-encoded. A JSON
//! body needs a preflight from any other origin, and the server's CORS policy
//! never allows credentials, so only the server's own pages can have a poll's
//! cookie set. Every answer is uncached: a start carries the pairing code,
//! and an approved poll the session's cookie.

use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::device_name_hint::device_name_from_user_agent;
use crate::domain::capabilities::oauth::{
    BrowserPairingPollError, BrowserPairingStartError, BrowserPairingStatus, StartedBrowserPairing,
    APPROVED_SESSION_TTL,
};
use crate::http::browser_session_set_cookie;
use crate::http::errors::InternalError;
use crate::http::extractors::Live;
use crate::http::wire_representations::CacheSuppressed;
use crate::live_bindings::LiveBrowserPairing;

/// `POST /oauth/pair/start` body.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct BrowserPairingStartBody {
    /// Where the browser goes once it holds its session: a path on this
    /// server, in practice an `/oauth/authorize` URL.
    next: String,
}

/// A started pairing, for the pairing page.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct StartedBrowserPairingBody {
    /// The secret the page polls with. Only this page holds it.
    pairing_code: String,
    /// The code the page shows, which the Owner confirms on the device page.
    user_code: String,
    /// The name the browser goes by until the page names it, taken from its
    /// user agent.
    browser_name: String,
    /// Where the page sends the browser once it holds its session: `next`,
    /// resolved against this server.
    next: String,
    /// Seconds until the request expires.
    expires_in: i64,
    /// Seconds the page waits between polls.
    interval: i64,
}

impl From<StartedBrowserPairing> for StartedBrowserPairingBody {
    fn from(started: StartedBrowserPairing) -> Self {
        StartedBrowserPairingBody {
            pairing_code: started.pairing_code,
            user_code: started.user_code,
            browser_name: started.browser_name,
            next: started.next.location().to_owned(),
            expires_in: started.expires_in,
            interval: started.interval,
        }
    }
}

/// Why a pairing didn't start: `next` is no path on this server
/// (`BrowserPairingNextNotAllowed`, 400), or the browser-session client is
/// disabled (`BrowserSessionClientDisabled`, 403).
#[derive(Debug, Serialize, ToSchema)]
pub(super) struct BrowserPairingRefused {
    error: &'static str,
}

/// `POST /oauth/pair/poll` body.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct BrowserPairingPollBody {
    /// The pairing code the start answered with.
    pairing_code: String,
    /// The name the page now gives its browser. Recorded while the request
    /// is pending; blank keeps the name it has.
    browser_name: String,
}

/// Where a pairing stands. `approved` carries the browser's session as its
/// `Set-Cookie`; the page then goes on to its `next`. `slow_down` means the
/// page polled sooner than its interval.
#[derive(Debug, Serialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(super) enum BrowserPairingStatusBody {
    Pending,
    SlowDown,
    Approved,
    Denied,
    Expired,
}

/// No browser pairing has the presented pairing code
/// (`BrowserPairingNotFound`, 404).
#[derive(Debug, Serialize, ToSchema)]
pub(super) struct BrowserPairingNotFound {
    error: &'static str,
}

/// Start a browser pairing for this browser, named after its `User-Agent`,
/// and raise the Owner's notification.
#[utoipa::path(
    post,
    tag = "Browser pairing",
    path = "/pair/start",
    request_body(content = BrowserPairingStartBody, content_type = "application/json"),
    responses(
        (status = 200, description = "The started pairing", body = StartedBrowserPairingBody),
        (status = 400, description = "`next` is no path on this server", body = BrowserPairingRefused),
        (status = 403, description = "The browser-session client is disabled", body = BrowserPairingRefused)
    )
)]
pub(super) async fn handle_browser_pairing_start(
    pairing: Live<LiveBrowserPairing>,
    headers: HeaderMap,
    Json(body): Json<BrowserPairingStartBody>,
) -> Response {
    let user_agent_name = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .and_then(device_name_from_user_agent);
    let response = match pairing.start(&body.next, user_agent_name, Utc::now()) {
        Ok(started) => Json(StartedBrowserPairingBody::from(started)).into_response(),
        Err(BrowserPairingStartError::NextNotAllowed) => (
            StatusCode::BAD_REQUEST,
            Json(BrowserPairingRefused {
                error: "BrowserPairingNextNotAllowed",
            }),
        )
            .into_response(),
        Err(BrowserPairingStartError::BrowserSessionClientDisabled) => (
            StatusCode::FORBIDDEN,
            Json(BrowserPairingRefused {
                error: "BrowserSessionClientDisabled",
            }),
        )
            .into_response(),
        Err(BrowserPairingStartError::UserCodeExhausted) => InternalError::new(
            "start a browser pairing",
            "exhausted every user_code generation attempt",
        )
        .into_response(),
        Err(BrowserPairingStartError::Store(error)) => {
            InternalError::new("start a browser pairing", error).into_response()
        }
    };
    CacheSuppressed(response).into_response()
}

/// Poll a browser pairing. The poll that finds it approved starts the
/// browser's approved session and sets it as the browser's
/// `__Host-browser_session` cookie.
#[utoipa::path(
    post,
    tag = "Browser pairing",
    path = "/pair/poll",
    request_body(content = BrowserPairingPollBody, content_type = "application/json"),
    responses(
        (status = 200, description = "Where the pairing stands", body = BrowserPairingStatusBody),
        (status = 404, description = "No pairing has the pairing code", body = BrowserPairingNotFound)
    )
)]
pub(super) async fn handle_browser_pairing_poll(
    pairing: Live<LiveBrowserPairing>,
    Json(body): Json<BrowserPairingPollBody>,
) -> Response {
    let response = match pairing.poll(&body.pairing_code, &body.browser_name, Utc::now()) {
        Ok(BrowserPairingStatus::Approved { session_token }) => (
            [(
                header::SET_COOKIE,
                browser_session_set_cookie(&session_token, APPROVED_SESSION_TTL),
            )],
            Json(BrowserPairingStatusBody::Approved),
        )
            .into_response(),
        Ok(BrowserPairingStatus::Pending) => {
            Json(BrowserPairingStatusBody::Pending).into_response()
        }
        Ok(BrowserPairingStatus::SlowDown) => {
            Json(BrowserPairingStatusBody::SlowDown).into_response()
        }
        Ok(BrowserPairingStatus::Denied) => Json(BrowserPairingStatusBody::Denied).into_response(),
        Ok(BrowserPairingStatus::Expired) => {
            Json(BrowserPairingStatusBody::Expired).into_response()
        }
        Err(BrowserPairingPollError::NotFound) => (
            StatusCode::NOT_FOUND,
            Json(BrowserPairingNotFound {
                error: "BrowserPairingNotFound",
            }),
        )
            .into_response(),
        Err(BrowserPairingPollError::Store(error)) => {
            InternalError::new("poll a browser pairing", error).into_response()
        }
        Err(BrowserPairingPollError::SessionNotStored(error)) => {
            InternalError::new("store an approved browser session", error).into_response()
        }
        Err(BrowserPairingPollError::Issuance(error)) => {
            InternalError::new("mint an approved browser session's token", error).into_response()
        }
    };
    CacheSuppressed(response).into_response()
}
