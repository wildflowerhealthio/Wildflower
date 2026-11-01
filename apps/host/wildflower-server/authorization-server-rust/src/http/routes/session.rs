//! `GET /authorization/session` — the caller reading back their *own* session.
//!
//! **Self-service, authN-only**, exactly like [`logout`](super::logout): every
//! field is derived from the token the caller already presented, or from the
//! browser session it was minted under, so the response can't disclose
//! anything about another caller, and no `Scoped<…>` capability
//! gates it — the `/authorization` mount's
//! [`require_valid_session`](crate::http::middleware::require_valid_session) gate
//! is the whole authorization it needs. That is load-bearing rather than merely
//! convenient: the callers who need this most are *under*-scoped sessions (one
//! that just took a `403 InsufficientScope`), and any admin scope gate would lock
//! exactly those out of reading their own scopes.
//!
//! The device-login screen reads it to seed the scope picker from the session's
//! real scopes rather than a hard-coded preset — the device flow mints a whole
//! new grant, so a step-up seeded from anything narrower silently *drops* access
//! the caller already had. The server's own pages read it for when this
//! browser's session expires, which they show as "Signed in until". See the
//! [Scope-Gated Endpoints How-To](../../../../../../../docs/Authorization/Scope-Gated%20Endpoints%20How-To.md).

use std::sync::Arc;

use axum::Json;
use chrono::{DateTime, Utc};
use serde::Serialize;
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;
use wildflowerhealthio_scope_capabilities::Authenticated;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::http::state::AuthorizationServerState;
use crate::live_bindings::LiveSessionReader;

/// The `/session` route table, as an `OpenApiRouter` so the spec is collected
/// from the route that serves traffic.
pub(crate) fn openapi_router() -> OpenApiRouter<Arc<AuthorizationServerState>> {
    OpenApiRouter::new().routes(routes!(handle_get_session))
}

/// What the caller's current access token carries: its scopes, and when the
/// browser session it was minted under expires. The rest of the claim set
/// (`jti`/`iss`/`aud`/`patient`) is session plumbing no caller has asked for,
/// and leaving it off keeps this from drifting into a general introspection
/// endpoint. Widen it when something actually needs a field.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct SessionResponse {
    /// The `scope` claim split on whitespace — the scopes this session actually
    /// holds. Empty when the token carries no `scope` claim at all.
    scopes: Vec<String>,
    /// When the browser session the token was minted under (its `sid`)
    /// expires; `null` for a token under no browser session.
    #[schema(value_type = Option<String>, format = DateTime, required = true)]
    browser_session_expires_at: Option<DateTime<Utc>>,
}

/// `GET /authorization/session`: the caller's own scopes and its browser
/// session's expiry, read from its claims through
/// `Authenticated<LiveSessionReader>`, which no scope gates.
#[utoipa::path(
    get,
    tag = "Session",
    path = "/session",
    responses(
        (status = 200, description = "The caller's own scopes and its browser session's expiry", body = SessionResponse),
        (status = 500, description = "The browser session store failed; logged, with no body"),
    ),
)]
async fn handle_get_session(
    session: Authenticated<LiveSessionReader>,
) -> Result<Json<SessionResponse>, AuthorizationServerError> {
    Ok(Json(SessionResponse {
        scopes: session.scopes(),
        browser_session_expires_at: session.browser_session_expires_at()?,
    }))
}
