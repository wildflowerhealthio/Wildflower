//! The hosted owner UI's gatekeeper pages, as an axum extractor. A handler that
//! sends a browser to one (the `/authorize` polling page, the device-flow
//! `verification_uri`, logout's landing) takes `pages: OwnerUiPages` rather than
//! reaching into the state for the configured base, then narrows it to the
//! requesting client with [`OwnerUiPages::for_client`] or
//! [`OwnerUiPages::for_signing_in_client`] — a first-party client may name the
//! copy of the owner UI it runs from (see
//! [`client_base_url`](crate::domain::client_base_url)).

use std::sync::Arc;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::response::Response;
use url::Url;

use shared_structures_rust::owner_ui::OwnerUiBase;

use crate::domain::client::RegisteredRedirectUri;
use crate::domain::client_base_url::{
    owner_ui_for_client, sign_in_owner_ui_for_client, ClientBaseUrl, SignInOwnerUi,
    CLIENT_BASE_URL_PARAM,
};
use crate::domain::client_redirect::resolve_registered_redirect;
use crate::domain::page_paths;
use crate::http::state::GatekeeperState;
use crate::http::ServedOrigin;
use crate::ports::SelfHostedRedirectResolver;

/// The hosted owner UI ([`OwnerUiBase`]), pointed at this request's served
/// origin — the server its pages should talk back to. Extracted on the
/// configured base; the `for_*client` narrowings swap in the requesting
/// client's own.
pub(crate) struct OwnerUiPages {
    base: OwnerUiBase,
    /// The copy the page on `base` offers to continue on first, carried as
    /// [`CLIENT_BASE_URL_PARAM`] — see [`SignInOwnerUi::ConfirmFirst`].
    confirm_continuing_on: Option<ClientBaseUrl>,
    server_origin: ServedOrigin,
    first_party_client_id: Arc<str>,
    self_hosted_redirects: Arc<dyn SelfHostedRedirectResolver>,
}

impl OwnerUiPages {
    /// These pages as an authenticated `client_id` should see them: on the base
    /// it `claimed` when it is first-party, on the configured base otherwise
    /// (see [`owner_ui_for_client`]).
    pub(crate) fn for_client(self, client_id: &str, claimed: Option<ClientBaseUrl>) -> Self {
        Self {
            base: owner_ui_for_client(&self.base, &self.first_party_client_id, client_id, claimed),
            ..self
        }
    }

    /// These pages as a signing-in `client_id` should see them: on the base it
    /// `claimed` only when one of its `registered_redirect_uris` vouches for
    /// it, and otherwise on the configured base, asking first (see
    /// [`sign_in_owner_ui_for_client`]).
    pub(crate) fn for_signing_in_client(
        self,
        client_id: &str,
        registered_redirect_uris: &[RegisteredRedirectUri],
        claimed: Option<ClientBaseUrl>,
    ) -> Self {
        let served = Url::parse(&self.server_origin).ok();
        let topology = self.self_hosted_redirects.resolve(client_id);
        let resolved_redirect_uris: Vec<Url> = registered_redirect_uris
            .iter()
            .filter_map(|entry| {
                resolve_registered_redirect(entry, served.as_ref(), topology.as_ref())
            })
            .collect();
        match sign_in_owner_ui_for_client(
            &self.base,
            &self.first_party_client_id,
            client_id,
            claimed,
            &resolved_redirect_uris,
        ) {
            SignInOwnerUi::Direct(base) => Self { base, ..self },
            SignInOwnerUi::ConfirmFirst {
                configured,
                claimed,
            } => Self {
                base: configured,
                confirm_continuing_on: Some(claimed),
                ..self
            },
        }
    }

    /// The owner UI's root, with no server named.
    pub(crate) fn root_url(&self) -> &str {
        self.base.as_url().as_str()
    }

    /// The OAuth polling page for authorization request `id`.
    pub(crate) fn oauth_polling_url(&self, id: &str) -> String {
        self.page_url(&page_paths::oauth_polling_path(id), &[])
    }

    /// The device-flow code-entry page.
    pub(crate) fn device_entry_url(&self) -> String {
        self.page_url(page_paths::device_entry_path(), &[])
    }

    /// The device-flow code-entry page with `user_code` pre-filled.
    pub(crate) fn device_entry_url_with_code(&self, user_code: &str) -> String {
        self.page_url(page_paths::device_entry_path(), &[("user_code", user_code)])
    }

    /// The page at `route`, with `extra_query` and then any copy to confirm
    /// continuing on.
    fn page_url(&self, route: &str, extra_query: &[(&str, &str)]) -> String {
        let confirm = self
            .confirm_continuing_on
            .as_ref()
            .map(|claimed| (CLIENT_BASE_URL_PARAM, claimed.as_str()));
        let query: Vec<(&str, &str)> = extra_query.iter().copied().chain(confirm).collect();
        self.base
            .route_url(route, &self.server_origin, &query)
            .into()
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
            confirm_continuing_on: None,
            server_origin: ServedOrigin::from_request_parts(parts, state).await?,
            first_party_client_id: state.first_party_client_id.clone(),
            self_hosted_redirects: state.self_hosted_redirects.clone(),
        })
    }
}
