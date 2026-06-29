//! Gatekeeper's served-origin axum extractor — wraps the shared
//! [`served_origin_for`] resolver (the single source of truth in
//! `shared-structures-rust`; see `docs/Origins/Explanation.md`). The extractor
//! stays here because it reaches into gatekeeper's [`AppState`] for the
//! `loopback_base_url` fallback, so it can't move to a state-agnostic crate
//! without parameterizing.

use std::convert::Infallible;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;

use shared_structures_rust::served_origin::served_origin_for;

use crate::http::state::AppState;

/// [`served_origin_for`] as an axum extractor: resolves the request's served
/// origin from its forwarding headers and the configured loopback origin, so a
/// handler takes `origin: ServedOrigin` instead of threading a `HeaderMap`
/// purely to call `served_origin_for`. Infallible — a request with no
/// forwarding headers falls back to `loopback_origin`.
pub(crate) struct ServedOrigin(pub String);

impl std::ops::Deref for ServedOrigin {
    type Target = str;

    /// Lets a `ServedOrigin` flow straight into the `&str` the origin-consuming
    /// helpers take (`&origin`), with no `as_str()` unwrap at each call site.
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl FromRequestParts<AppState> for ServedOrigin {
    type Rejection = Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        Ok(ServedOrigin(served_origin_for(
            &parts.headers,
            &state.loopback_base_url.origin().ascii_serialization(),
        )))
    }
}
