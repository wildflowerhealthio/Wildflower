//! `POST /access/logout` — ends the caller's session by revoking the presented
//! access token and redirecting to the hosted owner UI.
//!
//! **Self-service, authN-only:** logout is a caller ending *their own* session,
//! not an admin resource operation, so it takes no scope — the `/access` mount's
//! [`require_valid_session`](crate::http::middleware::require_valid_session) gate
//! (any valid, non-revoked bearer) is the whole authorization it needs, and it
//! acts on the already-verified claims through the authenticated-only
//! [`LiveSessionEnder`] rather than re-verifying.
//! The access token is a stateless JWT that keeps its own short TTL; the client
//! forgetting it ends the session in that client, so logout also **revokes** the
//! presented token's `jti` in the shared store, closing the window a leaked copy
//! could otherwise ride until `exp`. See #269.

use std::sync::Arc;

use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::post;
use axum::Router;
use scope_capabilities_rust::Authenticated;

use crate::http::extractors::OwnerUiPages;
use crate::http::state::GatekeeperState;
use crate::live_bindings::LiveSessionEnder;

pub fn router() -> Router<Arc<GatekeeperState>> {
    Router::new().route("/logout", post(handle_logout))
}

async fn handle_logout(session: Authenticated<LiveSessionEnder>, pages: OwnerUiPages) -> Response {
    // Revoke the presented session token so a leaked copy can't outlive the
    // logout. Best-effort by design: a store hiccup must never fail the logout.
    session.end();
    // `303 See Other` → the hosted owner UI's root (this server serves no UI of
    // its own); `303` downgrades a `POST` logout to a `GET`.
    Redirect::to(pages.root_url()).into_response()
}
