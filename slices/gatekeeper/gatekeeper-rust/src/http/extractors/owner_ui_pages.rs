//! The hosted owner UI's gatekeeper pages, as an axum extractor. A handler that
//! sends a browser to one (the `/authorize` polling page, the device-flow
//! `verification_uri`, logout's landing) takes `pages: OwnerUiPages` rather than
//! reaching into the state for the configured base, then narrows it to the
//! requesting client with [`OwnerUiPages::for_client`] — a first-party client
//! may name the copy of the owner UI it runs from (see
//! [`client_base_url`](crate::domain::client_base_url)).

use std::sync::Arc;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::response::Response;

use shared_structures_rust::owner_ui::OwnerUiBase;

use crate::domain::client_base_url::{owner_ui_for_client, ClientBaseUrl};
use crate::domain::page_paths;
use crate::http::state::GatekeeperState;
use crate::http::ServedOrigin;

/// The hosted owner UI ([`OwnerUiBase`]), pointed at this request's served
/// origin — the server its pages should talk back to. Extracted on the
/// configured base; [`OwnerUiPages::for_client`] swaps in the requesting
/// client's own.
pub(crate) struct OwnerUiPages {
    base: OwnerUiBase,
    server_origin: ServedOrigin,
    first_party_client_id: Arc<str>,
}

impl OwnerUiPages {
    /// These pages as `client_id` should see them: on the base it `claimed`
    /// when it is first-party, on the configured base otherwise (see
    /// [`owner_ui_for_client`]).
    pub(crate) fn for_client(self, client_id: &str, claimed: Option<ClientBaseUrl>) -> Self {
        Self {
            base: owner_ui_for_client(&self.base, &self.first_party_client_id, client_id, claimed),
            ..self
        }
    }

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
            first_party_client_id: state.first_party_client_id.clone(),
        })
    }
}
