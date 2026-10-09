//! The gatekeeper's request extractors — the [`ServedOrigin`] every OAuth
//! handler resolves its request's origin through, [`LauncherPages`] for the
//! hosted launcher pages a handler sends a browser to, and [`Live<F>`], the door to
//! the capabilities that no principal unlocks (see `crate::live_bindings`).
//! The scope-gated `Scoped<…>` and authenticated-only `Authenticated<…>`
//! extractors come from `scope-capabilities-rust`.

pub(crate) mod launcher_pages;
pub(crate) mod live;
pub(crate) mod served_origin;

pub(crate) use launcher_pages::LauncherPages;
pub(crate) use live::Live;
