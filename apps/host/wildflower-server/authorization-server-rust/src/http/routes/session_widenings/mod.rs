//! `/session-widenings/{id}` routes — the Owner-facing consent prompt for a
//! session widening: a paired browser asking, from its limited page, for its
//! browser session to hold more. One module per route (`get`, `approve`,
//! `deny`), each a documented handler; the decision result shared with
//! the other consent surfaces (`ConsentResult`) lives in
//! [`crate::http::wire_representations`], and the consent logic in
//! `domain::capabilities`. `openapi_router()` is the only path table.

/// `POST /session-widenings/{id}/approve`, and the approve body it reads.
mod approve;
/// `POST /session-widenings/{id}/deny`.
mod deny;
/// `GET /session-widenings/{id}`, and the prompt body it answers with.
mod get;

use std::sync::Arc;

use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::http::state::AuthorizationServerState;

/// The `/session-widenings` route table: the prompt, and its approve and
/// deny, as an `OpenApiRouter` so the spec is collected from the routes that
/// serve traffic.
pub(crate) fn openapi_router() -> OpenApiRouter<Arc<AuthorizationServerState>> {
    OpenApiRouter::new()
        .routes(routes!(get::handle_get_session_widening_consent))
        .routes(routes!(approve::handle_approve_session_widening))
        .routes(routes!(deny::handle_deny_session_widening))
}
