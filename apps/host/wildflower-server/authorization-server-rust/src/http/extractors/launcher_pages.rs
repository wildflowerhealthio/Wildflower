//! The hosted launcher, as an axum extractor. A handler that sends a browser
//! there (logout's landing) takes `pages: LauncherPages` rather than reaching
//! into the state for the configured base. The authorization server serves its
//! own pages (the wait page, the consent card, the device verification page).

use std::sync::Arc;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;

use wildflowerhealthio_shared_structures::launcher::LauncherBase;

use crate::http::state::AuthorizationServerState;

/// The hosted launcher ([`LauncherBase`]).
pub(crate) struct LauncherPages {
    base: LauncherBase,
}

impl LauncherPages {
    /// The launcher's root, with no server named.
    pub(crate) fn root_url(&self) -> &str {
        self.base.as_url().as_str()
    }
}

impl FromRequestParts<Arc<AuthorizationServerState>> for LauncherPages {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        _parts: &mut Parts,
        state: &Arc<AuthorizationServerState>,
    ) -> Result<Self, Self::Rejection> {
        Ok(Self {
            base: state.launcher_base.clone(),
        })
    }
}
