use axum::body::Body;
use axum::extract::{Extension, Request};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::Router;
use std::sync::Arc;

use crate::crypto::jwt::VerifyError;
use crate::require_auth::{bearer_token, verify_any_token, AppState, AuthedClaims};

async fn gate_middleware(
    Extension(state): Extension<AppState>,
    headers: HeaderMap,
    mut req: Request<Body>,
    next: Next,
) -> Response {
    // TODO(transport): assumes the WebView reaches us over loopback HTTP; if
    // it switches to tauri:// IPC, this gate must move.
    let token = match bearer_token(&headers) {
        Some(t) => t,
        None => return unauthorized(),
    };
    let claims = match verify_any_token(&state, &headers, &token) {
        Ok(c) => c,
        Err(VerifyError::NoSigningKeys) => return internal_error(),
        Err(_) => return unauthorized(),
    };
    req.extensions_mut().insert(AuthedClaims(Arc::new(claims)));
    next.run(req).await
}

/// Wrap a router (e.g. emr-rust's FHIR router) with JWT verification
/// against the gatekeeper's signing keys. Any request missing or
/// presenting an invalid bearer token gets 401.
pub fn gate(router: Router, state: AppState) -> Router {
    router
        .layer(middleware::from_fn(gate_middleware))
        .layer(Extension(state))
}

fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
}

fn internal_error() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, "internal_server_error").into_response()
}
