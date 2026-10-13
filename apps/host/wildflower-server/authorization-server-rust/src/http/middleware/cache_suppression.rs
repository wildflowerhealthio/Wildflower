//! Blanket cache-suppression for the Owner `/access/*` surface. Every response
//! there carries privileged data — pending consent prompts, device prompts,
//! standing grants, the session, approve/deny outcomes — that a shared or
//! browser cache must never retain. Applying it in one layer (rather than per
//! handler) makes the guarantee comprehensive: a new `/access` route, a 404, and
//! the session gate's 401 all inherit it without a call site having to
//! remember.
//!
//! Reuses [`CacheSuppressed`] — the same wrapper the `/oauth` handlers apply
//! per-response — as the single source of truth for the headers, so the two
//! surfaces can't drift.

use axum::body::Body;
use axum::extract::Request;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::http::wire_representations::CacheSuppressed;

/// Wrap every response flowing through this layer in [`CacheSuppressed`],
/// stamping `Cache-Control: no-store` + `Pragma: no-cache`. The headers are
/// inserted (not appended), so a handler that had already set either can't end
/// up with a duplicate.
pub async fn cache_suppress(req: Request<Body>, next: Next) -> Response {
    CacheSuppressed(next.run(req).await).into_response()
}
