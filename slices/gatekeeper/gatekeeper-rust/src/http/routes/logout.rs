//! `POST /access/logout` — ends the owner's web session by clearing the
//! `wf_auth` + `wf_auth_exp` cookies and redirecting to `/`.
//!
//! **Self-service, authN-only:** logout is a caller ending *their own* session,
//! not an admin resource operation, so it takes no scope — the `/access` mount's
//! [`require_valid_session`](crate::http::middleware::require_valid_session) gate
//! (any valid, non-revoked bearer/cookie) is the whole authorization it needs,
//! and it reads the already-verified [`CallerSession`] rather than re-verifying.
//! **`POST`-only is load-bearing for CSRF safety:** a `SameSite=Lax` cookie IS
//! sent on a cross-site *top-level GET navigation* (`window.location =
//! …/access/logout`, a clicked link), so exposing this as a `GET` would let any
//! attacker page force-logout the owner. Restricting it to `POST` closes that
//! hole — Lax does NOT attach the cookie to a cross-site `POST`, so the gate
//! can't be satisfied by a forged submission. The web UI drives it from a
//! same-origin `<form method="post">` (see the gatekeeper settings logout item).
//! The access token is a stateless JWT that keeps its own short TTL; clearing the
//! cookies just stops *this* browser from re-presenting it — so logout also
//! **revokes** the presented token's `jti` in the shared store, closing the
//! leaked-cookie window a copy of the token could otherwise ride until `exp`.
//! See #218 / #269.

use std::sync::Arc;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::post;
use axum::Router;

use crate::domain::token::VerifiedClaims;
use crate::http::state::GatekeeperState;
use crate::http::CallerSession;
use crate::http::ServedOrigin;
use crate::ports::SessionCookies;

pub fn router() -> Router<Arc<GatekeeperState>> {
    Router::new().route("/logout", post(handle_logout))
}

async fn handle_logout(
    State(state): State<Arc<GatekeeperState>>,
    CallerSession(claims): CallerSession,
    origin: ServedOrigin,
) -> Response {
    // Revoke the presented session token so a leaked copy can't outlive the
    // logout. Best-effort by design: the `/access` gate already verified this
    // request's token and handed us its trusted claims, so there's nothing to
    // re-verify — we just recover the `jti` + `exp` to denylist. Any hiccup (a
    // legacy no-`jti` token, an already-revoked token, or a transient store
    // error) must never block the cookie clear — leaving the session cookie in
    // place would be the worse outcome — so failures are logged and swallowed.
    revoke_presented_token(&state, &claims);

    let mut headers = HeaderMap::new();
    // Match the set form's `Secure` (HTTPS served origins only) so the clearing
    // `Set-Cookie` isn't dropped by Safari over http loopback — otherwise logout
    // wouldn't actually clear the session there. Cleared through the
    // `SessionCookies` port so the `wf_auth` format stays behind one seam.
    state.append_clear_session(&mut headers, origin.starts_with("https://"));
    // Attach the clearing `Set-Cookie`s to a `303 See Other` → `/`: the browser
    // drops the session cookies and navigates home in one hop, and `303`
    // downgrades a `POST` logout to a `GET` of the home page. `Redirect::to`
    // sets `Location`; the `HeaderMap` carries the `Set-Cookie`s alongside it.
    (headers, Redirect::to("/")).into_response()
}

/// Denylist the `jti` of the caller's verified session token, so the same token
/// can't be replayed from a leaked cookie after logout. Best-effort — see the
/// call site.
fn revoke_presented_token(state: &GatekeeperState, claims: &VerifiedClaims) {
    // A legacy token with no `jti` can't be denylisted individually (the
    // subject epoch is the bulk lever for those); and without an `exp` we've
    // nothing to key the sweep's cleanup on.
    let (Some(jti), Some(expires_at)) = (claims.jti.as_deref(), claims.expires_at) else {
        return;
    };
    // Best-effort denylist — the testable decision lives in the domain action.
    crate::domain::session::revoke_session_token(&state.revocation_store, jti, expires_at);
}
