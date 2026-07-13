//! [`CommonAppConfig`] — the interface every concrete per-kind configuration
//! (`CloudAppConfiguration` / `SelfHostedAppConfiguration` / `SystemAppConfiguration`)
//! implements: the two facts that are common across the kinds but computed
//! differently per kind.
//!
//!  - [`KIND`](CommonAppConfig::KIND) — which [`AppKind`] this configuration belongs
//!    to (a compile-time constant, since a concrete config type IS a single kind).
//!    The [`AppConfiguration`](super::AppConfiguration) union's `kind()` reads it off
//!    the active variant.
//!  - [`is_removable`](CommonAppConfig::is_removable) — may the owner delete this app
//!    through the admin surface? Cloud: yes; self-hosted: only when not `seeded`;
//!    system: no.
//!
//! Deliberately narrow: the concrete configs stay plain data read directly at the
//! wire seam, `is_smart` lives on the shared
//! [`AppRegistration`](super::AppRegistration) (derived from its `client_id`), and
//! launch resolution is HTTP/runtime-coupled — so none of those belong here.
//! `is_removable` reaches the client only on the per-kind detail wire shapes
//! ([`CloudAppDetail`](crate::http::wire_representations::CloudAppDetail) etc.), and
//! gates the unified `DELETE /apps/{id}`.

use super::AppKind;

/// The facts common to every concrete app configuration: its static [`AppKind`] and
/// its removability verdict. See the module docs for why the scope is this narrow.
pub trait CommonAppConfig {
    /// The kind this configuration belongs to — a constant, since a concrete config
    /// type maps to exactly one kind.
    const KIND: AppKind;

    /// Whether the owner can remove this app through the admin surface. See
    /// `docs/Apps/Explanation.md` §"Removability".
    fn is_removable(&self) -> bool;
}
