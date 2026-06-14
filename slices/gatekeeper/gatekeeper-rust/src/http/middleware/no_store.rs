//! Blanket cache-suppression for the Owner `/access/*` surface. Every response
//! there carries privileged data — pending consent prompts keyed by short
//! `user_code`s, standing grants, approve/deny outcomes — that a shared cache
//! must never retain. Stamping `Cache-Control: no-store` in one layer (rather
//! than per handler) makes the guarantee comprehensive: a new `/access` route,
//! a 404, a 401 from the owner-auth gate, and the rate-limiter's 429 all inherit
//! it without a call site having to remember.
//!
//! The OAuth surface (`/oauth/*`) suppresses caching per response via
//! [`CacheSuppressed`](crate::http::handlers) (RFC 6749 §5.1 also wants
//! `Pragma: no-cache`); this layer is the Owner-surface analogue and is kept off
//! `/oauth` so the two don't both write `Cache-Control` onto one response.

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderValue};
use axum::middleware::Next;
use axum::response::Response;

/// Stamp `Cache-Control: no-store` onto every response flowing through this
/// layer. Uses `insert` (not `append`) so the directive is set exactly once
/// even if an inner handler had already written one.
pub async fn set_no_store(req: Request<Body>, next: Next) -> Response {
    let mut response = next.run(req).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
