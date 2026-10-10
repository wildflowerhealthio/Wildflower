//! Apps domain types. [`AppRegistration`] is the authoritative `app_registrations`
//! row — the whole app (the catalogue facts, the launch `url` template, and the
//! homescreen placement) — both the diesel row and the `GET /apps` wire item.
//! [`AppsError`] is the semantic failure vocabulary the HTTP layer renders. The
//! [`AppsStore`] persistence port (the `SQLite` adapter lives in [`crate::db`]) and
//! the scope-gated [`capabilities`] the HTTP handlers acquire complete the
//! ports-and-adapters seam; each capability owns its operation's store logic
//! (synthesizing the registration a create/replace persists, mapping the store's
//! primitive signals onto [`AppsError`]) — including the by-id read, which each
//! capability inlines as `find_app` + `NotFound` (as does the launch route) —
//! while the [`actions`] module holds the write-side validator they share
//! (multi-caller logic kept out of the capabilities; collector inlined its
//! single-caller equivalents into its capabilities, tunnel keeps a single-file
//! `domain::actions`).

pub(crate) mod actions;
mod app_registration;
mod app_url;
mod apps_error;
mod apps_store;
pub(crate) mod capabilities;
// The in-memory `FakeAppsStore` shared by the scope-gated
// capability tests and the residual `actions` validator tests. Lives at the domain
// root (not under `actions`) since it's reused above that layer — the collector
// `domain::test_fake` placement.
#[cfg(test)]
pub(crate) mod test_fake;

pub(crate) use app_registration::is_exact_registry_permutation;
pub use app_registration::AppRegistration;
pub use app_url::{AppUrl, AppUrlError, LaunchParams};
pub use apps_error::AppsError;
pub use apps_store::AppsStore;
// The apps admin surface's grantable scope vocabulary (mirrors gatekeeper's
// `grantable_admin_scopes`) — re-exported so a consent surface / registry test can
// name it; `Apps.{r,c,u,d}` today.
pub use capabilities::grantable_apps_scopes;
