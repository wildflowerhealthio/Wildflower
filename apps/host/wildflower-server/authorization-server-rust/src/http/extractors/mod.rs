//! The authorization server's request extractors — the [`ServerOrigin`] a handler names
//! the server's own URLs on, [`LauncherPages`] for the
//! hosted launcher a handler sends a browser to, and [`Live<F>`], the door to
//! the capabilities that no principal unlocks (see `crate::live_bindings`).
//! The scope-gated `Scoped<…>` and authenticated-only `Authenticated<…>`
//! extractors come from `scope-capabilities-rust`.

pub(crate) mod launcher_pages;
pub(crate) mod live;
pub(crate) mod server_origin;

pub(crate) use launcher_pages::LauncherPages;
pub(crate) use live::Live;
