//! `POST /access/logout` (also `GET`) — ends the owner's web session by
//! clearing the `wf_auth` + `wf_auth_exp` cookies and redirecting to `/`.
//!
//! Owner-gated by the `/access` mount (`require_owner_auth`), so only an
//! authenticated owner can end their own session — the session cookie itself
//! satisfies the gate, and `SameSite=Lax` keeps a cross-site POST from carrying
//! it, so this can't be driven as a forced-logout CSRF. The access token is a
//! stateless JWT that keeps its own short TTL; clearing the cookies just stops
//! the browser from re-presenting it on the next navigation. See #218.

use axum::http::HeaderMap;
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::Router;

use crate::http::cookies;
use crate::http::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/logout", post(handle_logout))
        .route("/logout", get(handle_logout))
}

async fn handle_logout() -> Response {
    let mut headers = HeaderMap::new();
    cookies::append_clear_session_cookies(&mut headers);
    // Attach the clearing `Set-Cookie`s to a `303 See Other` → `/`: the browser
    // drops the session cookies and navigates home in one hop, and `303`
    // downgrades a `POST` logout to a `GET` of the home page. `Redirect::to`
    // sets `Location`; the `HeaderMap` carries the `Set-Cookie`s alongside it.
    (headers, Redirect::to("/")).into_response()
}
