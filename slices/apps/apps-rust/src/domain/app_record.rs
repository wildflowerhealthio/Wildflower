//! [`AppRecord`] — the behaviour every concrete app record shares: the two
//! catalogue *verdicts* whose rule differs per kind. Deliberately **not** a bag
//! of field-getters (the concrete structs stay plain data, read directly at the
//! wire seam) — only the real per-kind computations live here, so the removability
//! and SMART rules can't drift between the kinds:
//!
//!  - [`smart`](AppRecord::smart) — is this a SMART app? Cloud / self-hosted read
//!    it off their `client_id`; a system app never is.
//!  - [`removable`](AppRecord::removable) — may the owner delete it through the
//!    admin surface? Cloud: yes; self-hosted: only when not `seeded`; system: no.
//!
//! The wire projection ([`AppListEntry`](super::AppListEntry)) is the sole place
//! these reach the client, through the [`App`](super::App) seam.

/// The shared catalogue verdicts a concrete app record computes from its own
/// fields. See the module docs for why this is the only shared behaviour and why
/// it isn't a field-getter trait.
pub trait AppRecord {
    /// Whether this app is a SMART app (carries a gatekeeper OAuth `client_id`).
    fn smart(&self) -> bool;

    /// Whether the owner can remove this app through the admin surface. See
    /// `docs/Apps/Explanation.md` §"Removability".
    fn removable(&self) -> bool;
}
