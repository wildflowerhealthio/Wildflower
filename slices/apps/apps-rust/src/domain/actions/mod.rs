//! Shared domain building blocks the scope-gated
//! [`capabilities`](crate::domain::capabilities) are built from — the write-side
//! validator and the input DTO the HTTP layer builds:
//!
//!  - [`CloudAppPayload`] — the editable cloud content the HTTP layer maps its
//!    `CloudAppBody` onto (create + replace) before calling the capability, plus
//!    [`validate_cloud_fields`] that both write paths validate through.
//!
//! Everything here is pure input validation, so it stays unit-testable with no
//! database or HTTP layer in the way; the `SQLite` adapter's own coverage lives in
//! [`crate::db`].

mod cloud_apps;

pub(crate) use cloud_apps::{validate_cloud_fields, CloudAppPayload};
