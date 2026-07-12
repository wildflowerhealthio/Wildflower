//! Error **wire-representation** for the tunnel routes — the [`TunnelError`] →
//! response rendering. The failure *vocabulary* is domain
//! ([`crate::domain::TunnelError`]); this file only renders it onto the wire, so
//! a route bails with `?` and its `Result<_, TunnelError>` becomes a response
//! with no HTTP glue at the call site.
//!
//! The tunnel settings surface has no *semantic* error body: a stale-revision
//! write is a normal `200`-or-`409` carrying the current [`TunnelStateResponse`]
//! snapshot (part of the success type), not a `TunnelError`. So the only thing
//! rendered here is the opaque 500 for an
//! [`Infrastructure`](TunnelError::Infrastructure) failure — logged via the
//! shared [`InternalError`], answered as an empty body a client doesn't decode.
//! `Infrastructure` is therefore deliberately **not** modeled in the routes'
//! `#[utoipa::path]` responses (mirroring collector's `RemoteError::Backend`).
//!
//! [`TunnelStateResponse`]: super::routes::tunnel::wire_representations::TunnelStateResponse

use axum::response::{IntoResponse, Response};
use shared_structures_rust::http_errors::InternalError;

use crate::domain::TunnelError;

/// Render each [`TunnelError`] onto the wire. Its single
/// [`Infrastructure`](TunnelError::Infrastructure) variant is logged (via the
/// shared [`InternalError`]) and answered as an opaque, empty 500 — the operator
/// sees the detail, the client doesn't. This is the whole of the HTTP layer's
/// error knowledge; the routes just `?`.
impl IntoResponse for TunnelError {
    fn into_response(self) -> Response {
        match self {
            TunnelError::Infrastructure { context, source } => {
                InternalError::new(context, source).into_response()
            }
        }
    }
}
