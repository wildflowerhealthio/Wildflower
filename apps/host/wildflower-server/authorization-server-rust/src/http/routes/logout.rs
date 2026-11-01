//! `POST /authorization/logout` — ends the caller's session by revoking the presented
//! access token and redirecting to the hosted launcher.
//!
//! **Self-service, authN-only:** logout is a caller ending *their own* session,
//! not an admin resource operation, so it takes no scope — the `/authorization` mount's
//! [`require_valid_session`](crate::http::middleware::require_valid_session) gate
//! (any valid, non-revoked bearer) is the whole authorization it needs, and it
//! acts on the already-verified claims through the authenticated-only
//! [`LiveSessionEnder`] rather than re-verifying.
//! The access token is a stateless JWT that keeps its own short TTL; the client
//! forgetting it ends the session in that client, so logout also **revokes** the
//! presented token's `jti` in the shared store, closing the window a leaked copy
//! could otherwise ride until `exp`.

use std::sync::Arc;

use axum::response::{IntoResponse, Redirect, Response};
use chrono::Utc;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;
use wildflowerhealthio_scope_capabilities::Authenticated;

use crate::http::extractors::LauncherPages;
use crate::http::state::AuthorizationServerState;
use crate::live_bindings::LiveSessionEnder;

/// The `/logout` route table, as an `OpenApiRouter` so the spec is collected
/// from the route that serves traffic.
pub(crate) fn openapi_router() -> OpenApiRouter<Arc<AuthorizationServerState>> {
    OpenApiRouter::new().routes(routes!(handle_logout))
}

/// `POST /authorization/logout`: denylist the presented token's `jti`
/// through `Authenticated<LiveSessionEnder>`, then answer `303 See Other` to
/// the hosted launcher's root. No scope gates it.
#[utoipa::path(
    post,
    tag = "Session",
    path = "/logout",
    responses(
        (status = 303, description = "The token is revoked, best-effort: a store failure is logged and the logout goes ahead", headers(
            ("Location" = String, description = "The hosted launcher's root")
        )),
    ),
)]
async fn handle_logout(session: Authenticated<LiveSessionEnder>, pages: LauncherPages) -> Response {
    // Revoke the presented session token so a leaked copy can't outlive the
    // logout. Best-effort by design: a store hiccup must never fail the logout.
    session.end(Utc::now());
    // `303 See Other` → the hosted launcher's root (this server serves no UI of
    // its own); `303` downgrades a `POST` logout to a `GET`.
    Redirect::to(pages.root_url()).into_response()
}
