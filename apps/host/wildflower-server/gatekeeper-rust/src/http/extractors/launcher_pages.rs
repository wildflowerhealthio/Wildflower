//! The hosted launcher's gatekeeper pages, as an axum extractor. A handler that
//! sends a browser to one (the device-flow `verification_uri`, logout's landing)
//! takes `pages: LauncherPages` rather than reaching into the state for the
//! configured base. The `/authorize` wait page is not one of them: the
//! gatekeeper serves it itself.

use std::sync::Arc;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::response::Response;

use wildflowerhealthio_shared_structures::launcher::LauncherBase;

use crate::domain::page_paths;
use crate::http::state::GatekeeperState;
use crate::http::ServedOrigin;

/// The hosted launcher ([`LauncherBase`]), pointed at this request's served
/// origin — the server its pages should talk back to.
pub(crate) struct LauncherPages {
    base: LauncherBase,
    served_origin: ServedOrigin,
}

impl LauncherPages {
    /// The launcher's root, with no server named.
    pub(crate) fn root_url(&self) -> &str {
        self.base.as_url().as_str()
    }

    /// The device-flow code-entry page.
    pub(crate) fn device_entry_url(&self) -> String {
        page_paths::device_entry_url(&self.base, &self.served_origin)
    }

    /// The device-flow code-entry page with `user_code` pre-filled.
    pub(crate) fn device_entry_url_with_code(&self, user_code: &str) -> String {
        page_paths::device_entry_url_with_code(&self.base, &self.served_origin, user_code)
    }
}

impl FromRequestParts<Arc<GatekeeperState>> for LauncherPages {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<GatekeeperState>,
    ) -> Result<Self, Self::Rejection> {
        Ok(Self {
            base: state.launcher_base.clone(),
            served_origin: ServedOrigin::from_request_parts(parts, state).await?,
        })
    }
}
