//! `GET /access/session` — the caller reading back their *own* session.
//!
//! **Self-service, authN-only**, exactly like [`logout`](super::logout): every
//! field is derived from the token the caller already presented, so the response
//! can't disclose anything they don't already hold, and no `Scoped<…>` capability
//! gates it — the `/access` mount's
//! [`require_valid_session`](crate::http::middleware::require_valid_session) gate
//! is the whole authorization it needs. That is load-bearing rather than merely
//! convenient: the callers who need this most are *under*-scoped sessions (one
//! that just took a `403 InsufficientScope`), and any admin scope gate would lock
//! exactly those out of reading their own scopes.
//!
//! The device-login screen reads it to seed the scope picker from the session's
//! real scopes rather than a hard-coded preset — the device flow mints a whole
//! new grant, so a step-up seeded from anything narrower silently *drops* access
//! the caller already had. See the
//! [Scope-Gated Endpoints How-To](../../../../../../docs/Authorization/Scope-Gated%20Endpoints%20How-To.md).

use std::sync::Arc;

use axum::routing::get;
use axum::{Json, Router};
use scope_capabilities_rust::Authenticated;
use serde::Serialize;

use crate::http::state::GatekeeperState;
use crate::live_bindings::LiveSessionReader;

pub fn router() -> Router<Arc<GatekeeperState>> {
    Router::new().route("/session", get(handle_get_session))
}

/// What the caller's current access token carries. Just the scopes: the rest of
/// the claim set (`jti`/`iss`/`aud`/`patient`) is session plumbing no caller has
/// asked for, and leaving it off keeps this from drifting into a general
/// introspection endpoint. Widen it when something actually needs a field.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionResponse {
    /// The `scope` claim split on whitespace — the scopes this session actually
    /// holds. Empty when the token carries no `scope` claim at all.
    scopes: Vec<String>,
}

async fn handle_get_session(session: Authenticated<LiveSessionReader>) -> Json<SessionResponse> {
    Json(SessionResponse {
        scopes: session.scopes(),
    })
}
