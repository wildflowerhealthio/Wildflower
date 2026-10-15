//! The server's origin, as an axum extractor. A handler that names one of the
//! server's own URLs (the device verification page) takes
//! `server_origin: ServerOrigin` rather than reaching into the state. Every
//! request is served at the server's origin, `https://<domain>`. See
//! `docs/Origins/Explanation.md`.

use std::sync::Arc;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;

use crate::http::state::AuthorizationServerState;

/// The server's bare origin (`https://<domain>`).
pub(crate) struct ServerOrigin(Arc<str>);

impl std::ops::Deref for ServerOrigin {
    type Target = str;

    /// Lets a `ServerOrigin` flow straight into the `&str` the origin-consuming
    /// helpers take (`&server_origin`), with no unwrap at each call site.
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl FromRequestParts<Arc<AuthorizationServerState>> for ServerOrigin {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        _parts: &mut Parts,
        state: &Arc<AuthorizationServerState>,
    ) -> Result<Self, Self::Rejection> {
        Ok(Self(state.server_origin.clone()))
    }
}
