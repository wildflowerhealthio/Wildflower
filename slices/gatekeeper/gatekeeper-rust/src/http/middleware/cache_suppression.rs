//! Blanket cache-suppression for the Owner `/access/*` surface. Every response
//! there carries privileged data — pending consent prompts keyed by short
//! `user_code`s, standing grants, approve/deny outcomes — that a shared cache
//! must never retain. Applying it in one layer (rather than per handler) makes
//! the guarantee comprehensive: a new `/access` route, a 404, a 401 from the
//! owner-auth gate, and the rate-limiter's 429 all inherit it without a call
//! site having to remember.
//!
//! Reuses [`CacheSuppressed`] — the same wrapper the `/oauth` handlers apply
//! per-response — as the single source of truth for the cache-suppression
//! headers, so the two surfaces can't drift. The layer is kept off `/oauth`,
//! whose handlers already wrap their own responses, so the header isn't written
//! twice onto one response.

use axum::body::Body;
use axum::extract::Request;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::http::response_templates::CacheSuppressed;

/// Wrap every response flowing through this layer in [`CacheSuppressed`],
/// stamping `Cache-Control: no-store` + `Pragma: no-cache`. `/access` handlers
/// never set `Cache-Control` themselves, so the prepend doesn't duplicate it.
pub async fn cache_suppress(req: Request<Body>, next: Next) -> Response {
    CacheSuppressed(next.run(req).await).into_response()
}
