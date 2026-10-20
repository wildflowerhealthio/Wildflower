//! `/devices/{userCode}` routes — the Owner-facing consent prompt for the
//! device-code flow (RFC 8628). One module per route (`get`, `approve`,
//! `deny`), each exposing a `MethodRouter`; the DTOs shared with the code flow
//! (`ApproveBody`, `ConsentResult`) live in [`crate::http::wire_representations`],
//! the `get` response shape beside its route, and the consent logic in
//! `domain::capabilities`. `router()` is the only path table.

/// `POST /devices/{userCode}/approve`.
mod approve;
/// `POST /devices/{userCode}/deny`.
mod deny;
/// `GET /devices/{userCode}`, and the prompt body it answers with.
mod get;

use std::sync::Arc;

use axum::Router;

use crate::http::state::AuthorizationServerState;

/// The `/devices` route table: the prompt, and its approve and deny.
pub fn router() -> Router<Arc<AuthorizationServerState>> {
    Router::new()
        .route("/devices/{userCode}", get::route())
        .route("/devices/{userCode}/approve", approve::route())
        .route("/devices/{userCode}/deny", deny::route())
}
