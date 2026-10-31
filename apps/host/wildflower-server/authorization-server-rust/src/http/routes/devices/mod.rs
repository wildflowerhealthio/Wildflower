//! `/devices/{userCode}` routes — the Owner-facing consent prompt for the
//! device-code flow (RFC 8628). One module per route (`get`, `approve`,
//! `deny`), each a documented handler; the DTOs shared with the code flow
//! (`ApproveBody`, `ConsentResult`) live in [`crate::http::wire_representations`],
//! the `get` response shape beside its route, and the consent logic in
//! `domain::capabilities`. `openapi_router()` is the only path table.

/// `POST /devices/{userCode}/approve`.
mod approve;
/// `POST /devices/{userCode}/deny`.
mod deny;
/// `GET /devices/{userCode}`, and the prompt body it answers with.
mod get;

use std::sync::Arc;

use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::http::state::AuthorizationServerState;

/// The `/devices` route table: the prompt, and its approve and deny, as an
/// `OpenApiRouter` so the spec is collected from the routes that serve
/// traffic.
pub(crate) fn openapi_router() -> OpenApiRouter<Arc<AuthorizationServerState>> {
    OpenApiRouter::new()
        .routes(routes!(get::handle_get_device_consent))
        .routes(routes!(approve::handle_approve_device_consent))
        .routes(routes!(deny::handle_deny_device_consent))
}
