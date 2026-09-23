//! The gatekeeper's request extractors — the [`ServedOrigin`] every OAuth
//! handler resolves its request's origin through, and [`Live<F>`], the door to
//! the capabilities that no principal unlocks (see `crate::live_bindings`).
//! The scope-gated `Scoped<…>` and authenticated-only `Authenticated<…>`
//! extractors come from `scope-capabilities-rust`.

pub(crate) mod live;
pub(crate) mod served_origin;

pub(crate) use live::Live;
