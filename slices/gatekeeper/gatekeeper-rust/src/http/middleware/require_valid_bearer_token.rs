use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::HeaderMap;
use axum::middleware::Next;
use axum::response::Response;

use crate::http::response_templates;
use crate::http::served_origin_for;
use crate::http::state::AppState;

use crate::http::middleware::require_auth::{
    try_bearer_token_from_headers, verify_auth_token_claims,
};

pub async fn require_valid_bearer_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    req: Request<Body>,
    next: Next,
) -> Response {
    // TODO(transport): assumes the WebView reaches us over loopback HTTP; if
    // it switches to tauri:// IPC, this gate must move.
    let Some(token) = try_bearer_token_from_headers(&headers) else {
        return response_templates::unauthorized();
    };
    let origin = served_origin_for(&headers, &state.loopback_origin);
    if let Err(e) = verify_auth_token_claims(&state, &origin, &token) {
        return response_templates::verify_error_response("verify_auth_token_claims failed", e);
    }
    next.run(req).await
}
