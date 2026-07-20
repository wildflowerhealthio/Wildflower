//! Shared domain building blocks the scope-gated
//! [`capabilities`](crate::domain::capabilities) are built from — the reusable
//! pieces the capabilities hold in common. Each per-operation action used to live
//! here in its own file; that logic moved into the capability method that was its
//! only caller, leaving the write-side validators and the input DTO the HTTP layer
//! builds:
//!
//!  - [`CloudAppPayload`] — the editable cloud content the HTTP layer maps its
//!    `CloudAppBody` onto (create + replace) before calling the capability, plus
//!    [`validate_cloud_fields`] that both write paths validate through;
//!  - [`slugify`] / [`validate_launch_path`] — the self-hosted id derivation and
//!    launch-path validation the install / replace capabilities call.
//!
//! Everything here runs against the [`AppsStore`](crate::domain::AppsStore) port (or
//! pure input), so it stays unit-testable against the in-memory `FakeAppsStore` with
//! no database or HTTP layer in the way; the `SQLite` adapter's own coverage lives in
//! [`crate::db`].

mod cloud_apps;
mod self_hosted_apps;

pub(crate) use cloud_apps::{validate_cloud_fields, CloudAppPayload};
pub(crate) use self_hosted_apps::{slugify, validate_launch_path};
