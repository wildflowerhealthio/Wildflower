//! Error **wire-representations** for the `/sniffer` routes — the JSON body
//! shapes and the [`SnifferError`]→response rendering. The failure vocabulary
//! is domain ([`crate::domain::SnifferError`]); this file only renders it onto
//! the wire, so a route bails with `?` and its `Result<_, SnifferError>`
//! becomes a response with no HTTP glue at the call site.
//!
//! `InvalidSourceBody` (400) and the shared `InsufficientScopeBody` (403, from
//! `scope-capabilities-rust`) are modeled on both sides and declared in the
//! routes' `#[utoipa::path]` `responses`. `Infrastructure` is deliberately
//! **not** modeled — an opaque 500 carries no body a client decodes.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use shared_structures_rust::http_errors::InternalError;
use utoipa::ToSchema;

use crate::domain::SnifferError;

/// Wire shape for the 400 — the submitted `WebViewSource` was rejected
/// (non-http(s)/unparseable URI, or the unsupported `Html` variant). Under the
/// retired bridge these were warn-and-drops; a modelled body gives a non-UI
/// client a decodable failure.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct InvalidSourceBody {
    pub(crate) error: &'static str,
    pub(crate) message: String,
}

/// Render each [`SnifferError`] onto the wire. `InvalidSource` becomes its
/// documented 400; `InsufficientScope` renders through the shared helper (the
/// same body the `Scoped` extractor produces); an `Infrastructure` failure is
/// logged (via the shared [`InternalError`]) and answered as an opaque, empty
/// 500 — the operator sees the detail, the client doesn't.
impl IntoResponse for SnifferError {
    fn into_response(self) -> Response {
        match self {
            SnifferError::InvalidSource { message } => (
                StatusCode::BAD_REQUEST,
                Json(InvalidSourceBody {
                    error: "InvalidSource",
                    message,
                }),
            )
                .into_response(),
            SnifferError::InsufficientScope { missing_scopes } => {
                scope_capabilities_rust::insufficient_scope(missing_scopes)
            }
            SnifferError::Infrastructure { context, source } => {
                InternalError::new(context, source).into_response()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An `InvalidSource` renders as a 400 with the modelled body; an
    /// `Infrastructure` failure renders as an opaque 500.
    #[test]
    fn error_statuses_match_their_documentation() {
        let bad = SnifferError::InvalidSource {
            message: "nope".to_owned(),
        }
        .into_response();
        assert_eq!(bad.status(), StatusCode::BAD_REQUEST);

        let broken = SnifferError::Infrastructure {
            context: "test",
            source: anyhow::anyhow!("boom"),
        }
        .into_response();
        assert_eq!(broken.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    /// A [`SnifferError::InsufficientScope`] renders as a 403 through the
    /// shared helper — the same shape the `Scoped` extractor produces.
    #[test]
    fn insufficient_scope_renders_a_403() {
        let response = SnifferError::InsufficientScope {
            missing_scopes: vec!["wildflower/Sniffer.c".to_owned()],
        }
        .into_response();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}
