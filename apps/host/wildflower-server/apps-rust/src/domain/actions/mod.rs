//! Shared domain building blocks the scope-gated
//! [`capabilities`](crate::domain::capabilities) are built from — the write-side
//! validator and the input DTO the HTTP layer builds:
//!
//!  - [`AppPayload`] — the editable app content the HTTP layer maps its `AppBody`
//!    onto (create + replace) before calling the capability, plus
//!    [`validate_app_fields`] that both write paths validate through.
//!
//! Everything here is pure input validation, so it stays unit-testable with no
//! database or HTTP layer in the way; the `SQLite` adapter's own coverage lives in
//! [`crate::db`].

mod app_payload;

pub(crate) use app_payload::{validate_app_fields, AppPayload};
