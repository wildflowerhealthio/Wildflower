//! `POST /oauth/sign-out` — a browser ending its own browser session, from the
//! server's own pages' **Sign out** button (a form post). The request is
//! authenticated by the browser's `__Host-browser_session` cookie alone, so no
//! bearer is involved: the session the cookie holds is revoked, which ends
//! everything minted under it, the response clears the cookie, and the
//! browser is sent `303` to the hosted launcher's root, as
//! `POST /authorization/logout` sends it. A request with no cookie,
//! or one whose session has already ended, has nothing to revoke and is
//! answered the same way, so the browser always leaves signed out.
//!
//! The `Origin` check is the host's cookie→bearer layer's
//! (`wildflower-server-rust`'s `session_cookie_bearer`), which refuses any write
//! carrying the cookie from anywhere but the server's own origin, so another
//! page can't sign a browser out. A browser page, not API surface, so it is
//! kept out of the `OpenAPI` spec, like the sign-in.

use std::sync::Arc;

use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use chrono::Utc;

use crate::http::browser_session_clearing_set_cookie;
use crate::http::browser_session_cookie::carried_browser_session;
use crate::http::errors::InternalError;
use crate::http::extractors::{LauncherPages, Live};
use crate::http::state::AuthorizationServerState;
use crate::http::wire_representations::CacheSuppressed;
use crate::live_bindings::{LiveBrowserSessionEnder, LiveTokenVerifier};

/// The sign-out's route, relative to the `/oauth` mount.
pub(crate) fn router() -> Router<Arc<AuthorizationServerState>> {
    Router::new().route("/sign-out", post(handle_sign_out))
}

/// Revoke the browser session the request's cookie holds, if it holds a
/// standing one, then clear the cookie and `303` to the launcher's root. The
/// `303` turns the form's `POST` into a `GET`. A browser session that can't be
/// checked or revoked, because a store can't be read or written, is a `500`
/// that leaves the cookie as it was.
async fn handle_sign_out(
    token_verifier: Live<LiveTokenVerifier>,
    browser_session_ender: Live<LiveBrowserSessionEnder>,
    pages: LauncherPages,
    headers: HeaderMap,
) -> Response {
    let session_claims = match carried_browser_session(&token_verifier, &headers) {
        Ok(session_claims) => session_claims,
        Err(error) => {
            return InternalError::new("check the browser session to sign out", error)
                .into_response()
        }
    };
    if let Some(session_claims) = session_claims {
        if let Err(error) = browser_session_ender.end(&session_claims, Utc::now()) {
            return InternalError::new("revoke the browser session", error).into_response();
        }
    }
    CacheSuppressed((
        StatusCode::SEE_OTHER,
        [
            (header::LOCATION, pages.root_url().to_owned()),
            (header::SET_COOKIE, browser_session_clearing_set_cookie()),
        ],
    ))
    .into_response()
}
