//! [`AppBehaviour`] — the one catalogue *verdict* a per-kind configuration
//! computes from its own fields, and the only behaviour that genuinely differs
//! per kind: whether the owner may remove the app. Deliberately narrow — the
//! concrete configuration structs stay plain data read directly at the wire seam,
//! and the shared `is_smart` fact lives on the [`AppRegistration`](super::AppRegistration)
//! (derived from its `client_id`), not here.
//!
//!  - [`is_removable`](AppBehaviour::is_removable) — may the owner delete this app
//!    through the admin surface? Cloud: yes; self-hosted: only when not `seeded`;
//!    system: no.
//!
//! `is_removable` reaches the client only on the per-kind detail wire shapes
//! ([`CloudAppDetail`](crate::http::wire_representations::CloudAppDetail) etc.),
//! and gates the unified `DELETE /apps/{id}`.

/// The removability verdict a concrete app configuration computes from its own
/// fields. See the module docs for why this is the only per-kind behaviour.
pub trait AppBehaviour {
    /// Whether the owner can remove this app through the admin surface. See
    /// `docs/Apps/Explanation.md` §"Removability".
    fn is_removable(&self) -> bool;
}
