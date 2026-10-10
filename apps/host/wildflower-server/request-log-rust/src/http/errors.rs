//! Error **wire-representation** for the request-log routes — the
//! [`RequestLogError`] → response rendering. The failure *vocabulary* is domain
//! ([`crate::domain::RequestLogError`]); this file only renders it onto the
//! wire, so a route bails with `?` and its `Result<_, RequestLogError>` becomes
//! a response with no HTTP glue at the call site.
//!
//! The semantic `403` [`InsufficientScope`](RequestLogError::InsufficientScope)
//! renders the shared body (the `Scoped` extractor's rejection for an
//! under-scoped caller, declared in the routes' `#[utoipa::path]` responses). An
//! [`Infrastructure`](RequestLogError::Infrastructure) failure is logged via the
//! shared [`InternalError`] and answered as an empty 500 a client doesn't
//! decode, so it is deliberately **not** modeled in the routes'
//! `#[utoipa::path]` responses.

use axum::response::{IntoResponse, Response};
use wildflowerhealthio_shared_structures::http_errors::InternalError;

use crate::domain::RequestLogError;

/// Render each [`RequestLogError`] onto the wire: the shared `403` naming the
/// missing scope(s) (via [`wildflowerhealthio_scope_capabilities::insufficient_scope`]), or an
/// opaque, empty 500 for an infrastructure failure — the operator sees the
/// detail, the client doesn't.
impl IntoResponse for RequestLogError {
    fn into_response(self) -> Response {
        match self {
            RequestLogError::InsufficientScope { missing_scopes } => {
                wildflowerhealthio_scope_capabilities::insufficient_scope(missing_scopes)
            }
            RequestLogError::Infrastructure { context, source } => {
                InternalError::new(context, source).into_response()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;

    use super::*;

    /// The semantic `InsufficientScope` variant renders the shared `403` — the
    /// response the `Scoped` extractor rejects an under-scoped caller with.
    #[test]
    fn insufficient_scope_renders_a_403() {
        let response = RequestLogError::InsufficientScope {
            missing_scopes: vec!["wildflower/RequestLog.r".to_owned()],
        }
        .into_response();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn infrastructure_renders_a_500() {
        let response =
            RequestLogError::infrastructure("read failed", "disk on fire").into_response();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
}
