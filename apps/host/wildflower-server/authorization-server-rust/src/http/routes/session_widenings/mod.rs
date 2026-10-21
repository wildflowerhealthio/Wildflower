//! `/session-widenings/{id}` routes — the Owner-facing consent prompt for a
//! session widening: a paired browser asking, from its limited page, for its
//! browser session to hold more. One module per route (`get`, `approve`,
//! `deny`), each exposing a `MethodRouter`; the decision result shared with
//! the other consent surfaces (`ConsentResult`) lives in
//! [`crate::http::wire_representations`], and the consent logic in
//! `domain::capabilities`. `router()` is the only path table.

/// `POST /session-widenings/{id}/approve`, and the approve body it reads.
mod approve;
/// `POST /session-widenings/{id}/deny`.
mod deny;
/// `GET /session-widenings/{id}`, and the prompt body it answers with.
mod get;

use std::sync::Arc;

use axum::Router;

use crate::http::state::AuthorizationServerState;

/// The `/session-widenings` route table: the prompt, and its approve and
/// deny.
pub fn router() -> Router<Arc<AuthorizationServerState>> {
    Router::new()
        .route("/session-widenings/{id}", get::route())
        .route("/session-widenings/{id}/approve", approve::route())
        .route("/session-widenings/{id}/deny", deny::route())
}
