//! The router state is defined at the crate root ([`crate::live_bindings`]) so the
//! scope-gated capabilities in `domain/` can be built from it without `domain/`
//! depending on `crate::http`. This module re-exports it (so the many
//! `crate::http::state::GatekeeperState` call sites keep their path) and holds the
//! one seam impl that touches axum — clearing the owner session cookies takes a
//! [`HeaderMap`](axum::http::HeaderMap) — which therefore can't live beside the
//! axum-free state definition.

use std::sync::Arc;

pub use crate::live_bindings::GatekeeperState;
use crate::ports::SessionCookies;

/// The session-cookie clear seam — delegates to the crate-level cookie builder so
/// the `wf_auth` format stays in [`crate::cookies`]. On `Arc<GatekeeperState>`
/// because the logout handler holds and hands it one; the `HeaderMap` argument is
/// why this axum-touching impl lives in `http`, not beside the state.
impl SessionCookies for Arc<GatekeeperState> {
    fn append_clear_session(&self, headers: &mut axum::http::HeaderMap, secure: bool) {
        crate::cookies::append_clear_session_cookies(headers, secure);
    }
}
