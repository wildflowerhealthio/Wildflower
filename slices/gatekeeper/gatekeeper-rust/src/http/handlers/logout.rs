//! `POST /access/logout` — ends the owner's web session by clearing the
//! `wf_auth` + `wf_auth_exp` cookies.
//!
//! Owner-gated by the `/access` mount (`require_owner_auth`), so only an
//! authenticated owner can end their own session — the session cookie itself
//! satisfies the gate, and `SameSite=Lax` keeps a cross-site POST from carrying
//! it, so this can't be driven as a forced-logout CSRF. The access token is a
//! stateless JWT that keeps its own short TTL; clearing the cookies just stops
//! the browser from re-presenting it on the next navigation. See #218.

use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;

use crate::http::cookies;
use crate::http::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/logout", post(handle_logout))
}

async fn handle_logout() -> Response {
    let mut headers = HeaderMap::new();
    cookies::append_clear_session_cookies(&mut headers);
    (StatusCode::NO_CONTENT, headers).into_response()
}
