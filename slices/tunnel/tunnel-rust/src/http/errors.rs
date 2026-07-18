//! Error **wire-representation** for the tunnel routes — the [`TunnelError`] →
//! response rendering. The failure *vocabulary* is domain
//! ([`crate::domain::TunnelError`]); this file only renders it onto the wire, so
//! a route bails with `?` and its `Result<_, TunnelError>` becomes a response
//! with no HTTP glue at the call site.
//!
//! A stale-revision write is a normal `200`-or-`409` carrying the current
//! [`TunnelStateResponse`] snapshot (part of the success type), not a
//! `TunnelError`. So the two things rendered here are the semantic `403`
//! [`InsufficientScope`](TunnelError::InsufficientScope) (the shared body, also
//! rendered directly by the `Scoped` extractor and declared in the routes'
//! `#[utoipa::path]` responses) and the opaque 500 for an
//! [`Infrastructure`](TunnelError::Infrastructure) failure — logged via the
//! shared [`InternalError`], answered as an empty body a client doesn't decode.
//! `Infrastructure` is therefore deliberately **not** modeled in the routes'
//! `#[utoipa::path]` responses (mirroring collector's `RemoteError::Infrastructure`).
//!
//! [`TunnelStateResponse`]: super::routes::tunnel::wire_representations::TunnelStateResponse

use axum::response::{IntoResponse, Response};
use shared_structures_rust::http_errors::InternalError;

use crate::domain::TunnelError;

/// Render each [`TunnelError`] onto the wire. The semantic
/// [`InsufficientScope`](TunnelError::InsufficientScope) becomes the shared `403`
/// naming the missing scope(s) (via
/// [`scope_capabilities_rust::insufficient_scope`]); an
/// [`Infrastructure`](TunnelError::Infrastructure) failure is logged (via the
/// shared [`InternalError`]) and answered as an opaque, empty 500 — the operator
/// sees the detail, the client doesn't. This is the whole of the HTTP layer's
/// error knowledge; the routes just `?`.
impl IntoResponse for TunnelError {
    fn into_response(self) -> Response {
        match self {
            TunnelError::InsufficientScope { missing_scopes } => {
                scope_capabilities_rust::insufficient_scope(missing_scopes)
            }
            TunnelError::Infrastructure { context, source } => {
                InternalError::new(context, source).into_response()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;

    use super::*;

    /// The semantic `InsufficientScope` variant renders the shared `403` body
    /// (`{ error: "InsufficientScope", missingScopes: [...] }`) — the same shape
    /// the `Scoped` extractor emits when it rejects — so a capability method that
    /// surfaces it through the domain error channel is wire-identical to a gate
    /// rejection.
    #[test]
    fn insufficient_scope_renders_a_403() {
        let response = TunnelError::InsufficientScope {
            missing_scopes: vec!["wildflower/TunnelSettings.u".to_owned()],
        }
        .into_response();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}
