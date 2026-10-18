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
//! that [`can_decide_consents`]) passes without asking the gate yet: the layer
//! hands the route a [`DeferredStartLimit`] instead, and the route asks the
//! gate only once it knows the request will be raised for the Owner. So a
//! request the browser decides on its own consent card spends nothing, and
//! one it can't decide, as every device request, spends like any other. A
//! session the store can't vouch for doesn't defer; it asks the gate like any
//! other request. Every other request asks the gate, before the request is
//! parsed, so every attempt counts, however malformed; one it refuses is
//! answered `429 Too Many Requests`.
//!
//! `POST /authorization/oauth-consents/{id}/ask-owner` raises a request for
//! the Owner too, without starting one, so it spends from the same limit:
//! [`defer_authorization_start_limit`] hands it a [`DeferredStartLimit`],
//! which it asks only when it actually raises a request (not one raised
//! already).
//!
//! The authorization server knows nothing of who is asking beyond the
//! request; the host, which knows the connection a request arrived on, says
//! whether to admit it (`wildflower-server-rust`'s
//! `authorization_start_limit`: an allowance per visitor and one overall).

use std::sync::Arc;

use axum::extract::{FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{Extensions, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::http::browser_session_cookie::{can_decide_consents, carried_browser_session};
use crate::http::state::AuthorizationServerState;
use crate::http::wire_representations::CacheSuppressed;
use crate::live_bindings::{FromState, LiveTokenVerifier};
use crate::AuthorizationStartGate;

/// What a request the gate refuses is answered.
const RATE_LIMITED: &str = "too many authorization requests; try again later";

/// The answer to a start the gate refuses: `429 Too Many Requests`, uncached.
pub(crate) fn start_limited_response() -> Response {
    CacheSuppressed((StatusCode::TOO_MANY_REQUESTS, RATE_LIMITED)).into_response()
}

/// The authorization start limit, deferred by [`limit_authorization_starts`]
/// for a request carrying a browser session that can decide consents, as the
/// request's extension: the route asks it once the request is to be raised
/// for the Owner.
#[derive(Clone)]
pub(crate) struct DeferredStartLimit {
    gate: Arc<dyn AuthorizationStartGate>,
    /// The request's extensions as the layer saw them (its connect info),
    /// what the gate judges it by.
    request_extensions: Extensions,
}

impl DeferredStartLimit {
    /// Whether the gate admits the request now, spending from its allowance
    /// when it does.
    pub(crate) fn admits(&self) -> bool {
        self.gate.admit(&self.request_extensions)
    }
}

/// The start limit asked at once: extracted by a route every request of which
/// is raised for the Owner (`/oauth/device_authorization`), ahead of the
/// body, so a start whose limit the layer deferred asks it before the request
/// is parsed, like any other. Rejects with the `429` when the gate refuses.
pub(crate) struct StartLimitAskedNow;

impl<S: Send + Sync> FromRequestParts<S> for StartLimitAskedNow {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Response> {
        match parts.extensions.get::<DeferredStartLimit>() {
            Some(deferred_start_limit) if !deferred_start_limit.admits() => {
                Err(start_limited_response())
            }
            _ => Ok(StartLimitAskedNow),
        }
    }
}

/// Hand `request` a [`DeferredStartLimit`] for its route to ask, whoever
/// sends it: the layer on `POST /authorization/oauth-consents/{id}/ask-owner`,
/// which raises a request for the Owner without starting one, and asks the
/// limit only when it actually raises one.
pub(crate) async fn defer_authorization_start_limit(
    State(state): State<Arc<AuthorizationServerState>>,
    mut request: Request,
    next: Next,
) -> Response {
    let deferred_start_limit = DeferredStartLimit {
        gate: state.authorization_start_gate.clone(),
        request_extensions: request.extensions().clone(),
    };
    request.extensions_mut().insert(deferred_start_limit);
    next.run(request).await
}

/// Pass `request` on when it carries a live browser session that can decide
/// consents, with a [`DeferredStartLimit`] for the route to ask, or when the
/// state's [`AuthorizationStartGate`] admits it, and answer it
/// `429 Too Many Requests`, uncached, otherwise.
pub(crate) async fn limit_authorization_starts(
    State(state): State<Arc<AuthorizationServerState>>,
    mut request: Request,
    next: Next,
) -> Response {
    let token_verifier = LiveTokenVerifier::from_state(&state);
    if matches!(
        carried_browser_session(&token_verifier, request.headers()),
        Ok(Some(claims)) if can_decide_consents(&claims)
    ) {
        let deferred_start_limit = DeferredStartLimit {
            gate: state.authorization_start_gate.clone(),
            request_extensions: request.extensions().clone(),
        };
        request.extensions_mut().insert(deferred_start_limit);
        return next.run(request).await;
    }
    if state.authorization_start_gate.admit(request.extensions()) {
        return next.run(request).await;
    }
    start_limited_response()
}
