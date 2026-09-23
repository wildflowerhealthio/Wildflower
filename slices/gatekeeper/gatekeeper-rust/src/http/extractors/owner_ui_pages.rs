//! The hosted owner UI's gatekeeper pages, as an axum extractor. A handler that
//! sends a browser to one (the `/authorize` polling page, the device-flow
//! `verification_uri`, logout's landing) takes `pages: OwnerUiPages` rather than
//! reaching into the state for the configured base.

use std::sync::Arc;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::response::Response;

use shared_structures_rust::owner_ui::OwnerUiBase;

use crate::domain::page_paths;
use crate::http::state::GatekeeperState;
use crate::http::ServedOrigin;

/// The hosted owner UI ([`OwnerUiBase`]), pointed at this request's served
/// origin — the server its pages should talk back to.
pub(crate) struct OwnerUiPages {
    base: OwnerUiBase,
    server_origin: ServedOrigin,
}

impl OwnerUiPages {
    /// The owner UI's root, with no server named.
    pub(crate) fn root_url(&self) -> &str {
        self.base.as_url().as_str()
    }

    /// The OAuth polling page for authorization request `id`.
    pub(crate) fn oauth_polling_url(&self, id: &str) -> String {
        page_paths::oauth_polling_url(&self.base, &self.server_origin, id)
    }

    /// The device-flow code-entry page.
    pub(crate) fn device_entry_url(&self) -> String {
        page_paths::device_entry_url(&self.base, &self.server_origin)
    }

    /// The device-flow code-entry page with `user_code` pre-filled.
    pub(crate) fn device_entry_url_with_code(&self, user_code: &str) -> String {
        page_paths::device_entry_url_with_code(&self.base, &self.server_origin, user_code)
    }
}

impl FromRequestParts<Arc<GatekeeperState>> for OwnerUiPages {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<GatekeeperState>,
    ) -> Result<Self, Self::Rejection> {
        Ok(Self {
            base: state.owner_ui_base.clone(),
            server_origin: ServedOrigin::from_request_parts(parts, state).await?,
        })
    }
}
