use axum::body::Body;
use axum::extract::{Extension, Request};
use axum::http::HeaderMap;
use axum::middleware::Next;
use axum::response::Response;
use std::sync::Arc;

use crate::http::responses::{unauthorized, verify_error_response};
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
        Err(e) => return verify_error_response("verify_any_token failed", e),
    };
    req.extensions_mut().insert(AuthedClaims(Arc::new(claims)));
    next.run(req).await
}
