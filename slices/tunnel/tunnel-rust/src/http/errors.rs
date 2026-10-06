//! Error **wire-representation** for the tunnel routes — the [`TunnelError`] →
//! response rendering. The failure *vocabulary* is domain
//! ([`crate::domain::TunnelError`]); this file only renders it onto the wire.
//! The one thing rendered here is the semantic `403`
//! [`InsufficientScope`](TunnelError::InsufficientScope) (the shared body — the
//! `Scoped` extractor's rejection for an under-scoped caller — declared in the
//! route's `#[utoipa::path]` responses).

use axum::response::{IntoResponse, Response};

use crate::domain::TunnelError;

/// Render each [`TunnelError`] onto the wire. The semantic
/// [`InsufficientScope`](TunnelError::InsufficientScope) becomes the shared `403`
/// naming the missing scope(s) (via
/// [`scope_capabilities_rust::insufficient_scope`]).
impl IntoResponse for TunnelError {
    fn into_response(self) -> Response {
        match self {
            TunnelError::InsufficientScope { missing_scopes } => {
                scope_capabilities_rust::insufficient_scope(missing_scopes)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;

    use super::*;

    /// The semantic `InsufficientScope` variant renders the shared `403` body
    /// (`{ error: "InsufficientScope", missingScopes: [...] }`) — the response the
    /// `Scoped` extractor rejects an under-scoped caller with.
    #[test]
    fn insufficient_scope_renders_a_403() {
        let response = TunnelError::InsufficientScope {
            missing_scopes: vec!["wildflower/TunnelSettings.r".to_owned()],
        }
        .into_response();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}
