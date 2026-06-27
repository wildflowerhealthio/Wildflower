//! [`OwnerAuth`] — the host seam that authorizes a **loopback** launch. The
//! on-device webview popup is a side-effect on the owner's machine, and a
//! `Loopback` request provenance is only the *absence* of a `Forwarded` header
//! (header-derived, so not a sufficient gate on its own). When the launch
//! handler classifies a request as loopback it asks this trait whether the
//! caller is the owner, and `401`s if not.
//!
//! The host wires the real implementation (e.g. the gatekeeper owner-token
//! check) when it builds [`AppsState`](crate::http::AppsState). A forwarded
//! launch skips this check — the trusted front is the boundary for remote
//! callers, and the host never opens a popup for them anyway.

use axum::http::HeaderMap;

/// Authorizes a loopback launch. `is_owner` is handed the request `headers` and
/// the `served_origin` the request resolved to, so a host implementation can
/// validate an owner token (audience-bound to that origin) without re-deriving
/// provenance.
pub trait OwnerAuth: Send + Sync {
    /// Whether the loopback caller is the device owner. Returning `false` makes
    /// the launch handler respond `401` instead of opening the popup.
    fn is_owner(&self, headers: &HeaderMap, served_origin: &str) -> bool;
}

/// A test/no-op [`OwnerAuth`] with a fixed answer. The host supplies a real
/// implementation; tests use `AllowOwner::default()` (allow) or
/// `AllowOwner::denied()` (deny) to drive the gate either way.
#[derive(Debug, Clone, Copy)]
pub struct AllowOwner {
    allow: bool,
}

impl AllowOwner {
    /// An [`OwnerAuth`] that denies every loopback launch.
    #[must_use]
    pub fn denied() -> Self {
        Self { allow: false }
    }
}

impl Default for AllowOwner {
    /// Allow every loopback launch — the default test double.
    fn default() -> Self {
        Self { allow: true }
    }
}

impl OwnerAuth for AllowOwner {
    fn is_owner(&self, _headers: &HeaderMap, _served_origin: &str) -> bool {
        self.allow
    }
}
