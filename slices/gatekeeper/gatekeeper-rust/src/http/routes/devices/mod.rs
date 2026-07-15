//! `/devices/{userCode}` routes — the Owner-facing consent prompt for the
//! device-code flow (RFC 8628). One module per route (`get`, `approve`,
//! `deny`), each exposing a `MethodRouter`; the DTOs shared with the code flow
//! (`ApproveBody`, `ConsentResult`) live in [`crate::http::wire_representations`],
//! the `get` response shape beside its route, and the consent logic in
//! [`crate::domain::actions`]. `router()` is the only path table.

mod approve;
mod deny;
mod get;

use axum::Router;

use crate::http::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/devices/{userCode}", get::route())
        .route("/devices/{userCode}/approve", approve::route())
        .route("/devices/{userCode}/deny", deny::route())
}
