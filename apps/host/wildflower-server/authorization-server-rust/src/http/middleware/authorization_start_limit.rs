//! The limit on starting authorization requests: the layer on the two routes
//! that start one, `GET /oauth/authorize` and
//! `POST /oauth/device_authorization`, which asks the host's
//! [`AuthorizationStartGate`](crate::AuthorizationStartGate).
//!
//! Anyone who knows the server's domain can start a request, and each one
//! parks a request and raises the Owner's approval popup on the server's
//! device. The layer sits on those two routes alone, so it covers every
//! method axum serves them on (`HEAD /oauth/authorize` too) and no other
//! route. A request from a browser whose session can decide consents (it
//! carries a live browser session, as [`carried_browser_session`] reads it,
//! that [`can_decide_consents`]) passes without asking the gate, so it spends
//! nothing. A session the store can't vouch for doesn't pass; it asks the
//! gate like any other request. Every other request asks the gate, before the
//! request is parsed, so every attempt counts, however malformed; one it
//! refuses is answered `429 Too Many Requests`.
//!
//! The authorization server knows nothing of who is asking beyond the
//! request; the host, which knows the connection a request arrived on, says
//! whether to admit it (`wildflower-server-rust`'s
//! `authorization_start_limit`: an allowance per visitor and one overall).

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::http::browser_session_cookie::{can_decide_consents, carried_browser_session};
use crate::http::state::AuthorizationServerState;
use crate::http::wire_representations::CacheSuppressed;
use crate::live_bindings::{FromState, LiveTokenVerifier};

/// What a request the gate refuses is answered.
const RATE_LIMITED: &str = "too many authorization requests; try again later";

/// Pass `request` on when it carries a live browser session that can decide
/// consents or the state's
/// [`AuthorizationStartGate`](crate::AuthorizationStartGate) admits it, and
/// answer it `429 Too Many Requests`, uncached, otherwise.
pub(crate) async fn limit_authorization_starts(
    State(state): State<Arc<AuthorizationServerState>>,
    request: Request,
    next: Next,
) -> Response {
    let token_verifier = LiveTokenVerifier::from_state(&state);
    if matches!(
        carried_browser_session(&token_verifier, request.headers()),
        Ok(Some(claims)) if can_decide_consents(&claims)
    ) || state.authorization_start_gate.admit(request.extensions())
    {
        return next.run(request).await;
    }
    CacheSuppressed((StatusCode::TOO_MANY_REQUESTS, RATE_LIMITED)).into_response()
}
