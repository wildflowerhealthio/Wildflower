//! Error **wire-representation** for the tunnel routes — the [`TunnelError`] →
//! response rendering. The failure *vocabulary* is domain
//! ([`crate::domain::TunnelError`]); this file only renders it onto the wire, so
//! a route bails with `?` and its `Result<_, TunnelError>` becomes a response
//! with no HTTP glue at the call site.
//!
//! A stale-revision write is a normal `200`-or-`409` carrying the current
//! [`TunnelStateResponse`] snapshot (part of the success type), not a
//! `TunnelError`. So the things rendered here are the semantic `403`
//! [`InsufficientScope`](TunnelError::InsufficientScope) (the shared body — the
//! `Scoped` extractor's rejection for an under-scoped caller — declared in the
//! routes' `#[utoipa::path]` responses), the semantic `400`
//! [`InvalidPublicHost`](TunnelError::InvalidPublicHost) ([`InvalidPublicHostBody`],
//! declared on `PUT /tunnel`), and the opaque 500 for an
//! [`Infrastructure`](TunnelError::Infrastructure) failure — logged via the
//! shared [`InternalError`], answered as an empty body a client doesn't decode.
//! `Infrastructure` is therefore deliberately **not** modeled in the routes'
//! `#[utoipa::path]` responses (mirroring collector's `RemoteError::Infrastructure`).
//!
//! [`TunnelStateResponse`]: super::routes::tunnel::wire_representations::TunnelStateResponse

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use shared_structures_rust::http_errors::InternalError;
use utoipa::ToSchema;

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
            TunnelError::InvalidPublicHost { message } => (
                StatusCode::BAD_REQUEST,
                Json(InvalidPublicHostBody {
                    error: "InvalidPublicHost",
                    message,
                }),
            )
                .into_response(),
            TunnelError::Infrastructure { context, source } => {
                InternalError::new(context, source).into_response()
            }
        }
    }
}

/// Wire shape for a 400 `InvalidPublicHost` — a `PUT /tunnel` whose
/// `publicHost` isn't a bare `host[:port]`. Matches the TS
/// `InvalidPublicHostSchema`.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct InvalidPublicHostBody {
    pub(crate) error: &'static str,
    pub(crate) message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The semantic `InsufficientScope` variant renders the shared `403` body
    /// (`{ error: "InsufficientScope", missingScopes: [...] }`) — the response the
    /// `Scoped` extractor rejects an under-scoped caller with.
    #[test]
    fn insufficient_scope_renders_a_403() {
        let response = TunnelError::InsufficientScope {
            missing_scopes: vec!["wildflower/TunnelSettings.u".to_owned()],
        }
        .into_response();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn invalid_public_host_renders_a_400() {
        let response = TunnelError::InvalidPublicHost {
            message: "bad host".to_owned(),
        }
        .into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
