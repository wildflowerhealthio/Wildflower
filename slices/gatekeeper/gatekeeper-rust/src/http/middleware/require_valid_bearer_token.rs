use axum::body::Body;
use axum::extract::{Extension, Request};
use axum::http::HeaderMap;
use axum::middleware::Next;
use axum::response::Response;

use crate::http::responses::{unauthorized, verify_error_response};
use crate::http::served_origin_for;
use crate::http::state::AppState;

use crate::http::middleware::require_auth::{
    try_bearer_token_from_headers, verify_auth_token_claims,
};

pub async fn require_valid_bearer_token(
    Extension(state): Extension<AppState>,
    headers: HeaderMap,
    req: Request<Body>,
    next: Next,
) -> Response {
    // TODO(transport): assumes the WebView reaches us over loopback HTTP; if
    // it switches to tauri:// IPC, this gate must move.
    let token = match try_bearer_token_from_headers(&headers) {
        Some(t) => t,
        None => return unauthorized(),
    };
    let origin = served_origin_for(&headers, &state.loopback_origin);
    if let Err(e) = verify_auth_token_claims(&state, &origin, &token) {
        return verify_error_response("verify_auth_token_claims failed", e);
    }
    next.run(req).await
}
