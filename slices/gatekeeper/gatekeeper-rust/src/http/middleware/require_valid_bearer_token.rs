use axum::body::Body;
use axum::extract::{Extension, Request};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::sync::Arc;

use crate::domain::token::VerifyError;
use crate::http::state::AppState;

use crate::http::middleware::require_auth::{bearer_token, verify_any_token, AuthedClaims};

pub async fn require_valid_bearer_token(
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
        Err(VerifyError::NoSigningKeysConfigured) => return internal_error(),
        Err(_) => return unauthorized(),
    };
    req.extensions_mut().insert(AuthedClaims(Arc::new(claims)));
    next.run(req).await
}

fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
}

fn internal_error() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, "internal_server_error").into_response()
}
