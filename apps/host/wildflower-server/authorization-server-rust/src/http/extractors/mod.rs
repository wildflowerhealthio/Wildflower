//! The authorization server's request extractors — [`LauncherPages`] for the
//! hosted launcher a handler sends a browser to, and [`Live<F>`], the door to
//! the capabilities that no principal unlocks (see `crate::live_bindings`).
//!
//! A handler never names the router state: it takes one of three extractors,
//! and the extractor builds the capability.
//!
//! - `Scoped<F>` builds `F` from the state and the claims the session gate
//!   stored, and only when those claims cover `F`'s required scopes; a token
//!   short of one is a `403` listing the scopes it lacks, and the handler never
//!   runs.
//! - `Authenticated<F>` builds `F` from the state and the claims whole, with no
//!   gate beyond the session gate: for a caller acting on its own session
//!   (logout, reading its own scopes).
//! - [`Live<F>`] builds `F` from the state alone, with no gate at extraction:
//!   the front door's capabilities are gated by the proofs their methods take,
//!   not by a scope.
//!
//! `Scoped` and `Authenticated` come from `scope-capabilities-rust`; both fail
//! closed with a `500` when they find no claims, since that means a route was
//! mounted without its gate. A source guard holds handlers to reaching the
//! state only through these extractors.

pub(crate) mod launcher_pages;
pub(crate) mod live;

pub(crate) use launcher_pages::LauncherPages;
pub(crate) use live::Live;
