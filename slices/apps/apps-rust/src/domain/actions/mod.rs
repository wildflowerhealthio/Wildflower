//! Domain actions over the [`AppsStore`](crate::domain::AppsStore) port — the seam
//! the HTTP routes call instead of touching a concrete store. Each function takes
//! `&impl AppsStore`, so it runs against the `SQLite` adapter in production and
//! against an in-memory fake in tests, with no database or HTTP layer in the way.
//!
//! This is where the apps slice's semantics live: the actions **synthesize** the
//! `(registration, configuration)` a create/replace persists (the store takes only
//! those two real halves), validate the write-side fields ([`AppUrl`](crate::domain::AppUrl)
//! parsing, the launch-path shape), gate on kind + seeded (a per-kind path given an
//! id of another kind is a [`NotFound`](crate::domain::AppsError::NotFound) `404`; a
//! seeded self-hosted edit is a [`NotEditable`](crate::domain::AppsError::NotEditable)
//! `409`), and map the store's primitive signals — absence / non-permutation
//! (`Option`), a delete miss (`bool`), a granular insert failure — onto the semantic
//! [`AppsError`](crate::domain::AppsError) variants. The HTTP handlers stay thin:
//! parse the body, build the action's input struct, call an action.
//!
//! One file per app kind, so each kind's input struct, validation, and semantic
//! mapping live together:
//!
//!  - [`app_registration`] — the cross-kind catalogue read + the homescreen
//!    placement rewrite (both operate on registrations);
//!  - [`cloud_apps`] / [`self_hosted_apps`] / [`system_apps`] — the per-kind detail
//!    reads, creates, and replaces (and their input structs);
//!  - [`all_kinds_apps`] — the reads/deletes that resolve any kind by id.
//!
//! Mirrors collector's `actions.rs` (now grown into a folder for the same reason).

mod all_kinds_apps;
mod app_registration;
mod cloud_apps;
mod self_hosted_apps;
mod system_apps;

// `pub(crate)` (not `mod`) so the scope-gated capability tests in
// `crate::domain::capabilities` can reuse the same in-memory `FakeAppsStore` /
// `FakeInstaller` these action tests seed against.
#[cfg(test)]
pub(crate) mod test_fake;

pub(crate) use all_kinds_apps::{delete_app, get_app};
pub(crate) use app_registration::{list_registrations, replace_placements};
pub(crate) use cloud_apps::{create_cloud_app, get_cloud_app, replace_cloud_app, CloudAppPayload};
pub(crate) use self_hosted_apps::{
    get_self_hosted_app, install_self_hosted_app, replace_self_hosted_app, SelfHostedAppPayload,
};
pub(crate) use system_apps::get_system_app;
