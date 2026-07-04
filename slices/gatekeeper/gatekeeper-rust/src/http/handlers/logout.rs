//! `POST /access/logout` — ends the owner's web session by clearing the
//! `wf_auth` + `wf_auth_exp` cookies and redirecting to `/`.
//!
//! Owner-gated by the `/access` mount (`require_owner_auth`), so only an
//! authenticated owner can end their own session — the session cookie itself
//! satisfies the gate. **`POST`-only is load-bearing for CSRF safety:** a
//! `SameSite=Lax` cookie IS sent on a cross-site *top-level GET navigation*
//! (`window.location = …/access/logout`, a clicked link), so exposing this as a
//! `GET` would let any attacker page force-logout the owner. Restricting it to
//! `POST` closes that hole — Lax does NOT attach the cookie to a cross-site
//! `POST`, so the gate can't be satisfied by a forged submission. The web UI
//! drives it from a same-origin `<form method="post">` (see the gatekeeper
//! settings logout item). The access token is a stateless JWT that keeps its own
//! short TTL; clearing the cookies just stops the browser from re-presenting it
//! on the next navigation. See #218.

use axum::http::HeaderMap;
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::post;
use axum::Router;

use crate::http::cookies;
use crate::http::state::AppState;
use crate::http::ServedOrigin;

pub fn router() -> Router<AppState> {
    Router::new().route("/logout", post(handle_logout))
}

async fn handle_logout(origin: ServedOrigin) -> Response {
    let mut headers = HeaderMap::new();
    // Match the set form's `Secure` (HTTPS served origins only) so the clearing
    // `Set-Cookie` isn't dropped by Safari over http loopback — otherwise logout
    // wouldn't actually clear the session there. See `cookies`.
    cookies::append_clear_session_cookies(&mut headers, origin.starts_with("https://"));
    // Attach the clearing `Set-Cookie`s to a `303 See Other` → `/`: the browser
    // drops the session cookies and navigates home in one hop, and `303`
    // downgrades a `POST` logout to a `GET` of the home page. `Redirect::to`
    // sets `Location`; the `HeaderMap` carries the `Set-Cookie`s alongside it.
    (headers, Redirect::to("/")).into_response()
}
