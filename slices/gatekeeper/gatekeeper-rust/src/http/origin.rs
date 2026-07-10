//! Gatekeeper's served-origin axum extractor — wraps the shared
//! [`served_base_url_for`] resolver (the single source of truth in
//! `shared-structures-rust`; see `docs/Origins/Explanation.md`). The extractor
//! stays here because it reaches into gatekeeper's [`AppState`] for the
//! `loopback_base_url` fallback, so it can't move to a state-agnostic crate
//! without parameterizing.

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::response::Response;

use shared_structures_rust::served_origin::served_base_url_for;

use crate::http::response_templates;
use crate::http::state::AppState;

/// [`served_base_url_for`] as an axum extractor: resolves the request's served
/// base URL from its forwarding headers and the configured loopback base URL,
/// then hands handlers the bare origin string, so a handler takes
/// `origin: ServedOrigin` instead of threading a `HeaderMap` purely to call the
/// resolver. A request with no forwarding headers falls back to the loopback
/// origin; a forwarded host that cleared validation but failed to parse rejects
/// with an opaque 500 (see [`served_base_url_for`]).
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
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let base_url =
            served_base_url_for(&parts.headers, &state.loopback_base_url).ok_or_else(|| {
                response_templates::internal_error(
                    "served base url",
                    "forwarded header did not indicate a valid base URL",
                )
            })?;
        Ok(ServedOrigin(shared_structures_rust::origin_string(
            &base_url,
        )))
    }
}
