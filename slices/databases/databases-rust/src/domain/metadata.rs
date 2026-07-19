//! The wire metadata shape for a single database. A **pure** serde/utoipa type —
//! the best-effort filesystem/SQLite reads that populate it live in the
//! [`DatabaseFiles`](crate::ports::DatabaseFiles) adapter ([`crate::adapters`]),
//! so this layer carries no `std::fs`/`rusqlite` logic and `domain/` stays
//! swappable.

use serde::Serialize;
use utoipa::ToSchema;

/// Metadata for one database, as returned by `GET /databases`. Mirrors the TS
/// `DatabaseMetadataSchema` (`databases-core`, `#[serde(rename_all =
/// "camelCase")]`).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DatabaseMetadata {
    /// Resource id == filename, e.g. `health-data.sqlite`.
    pub(crate) id: String,
    /// Human label, e.g. `Health data`.
    pub(crate) label: String,
    /// One-line description of what the database holds.
    pub(crate) description: String,
    /// Whether the file currently exists on disk.
    pub(crate) exists: bool,
    /// File size in bytes (`0` when the file is absent). `u64` serializes to
    /// OpenAPI `integer`; a SQLite file stays far below `2^53`, so the TS
    /// `Schema.Int` client reads it losslessly.
    pub(crate) size_bytes: u64,
    /// Best-effort count of user tables — the "fun" bit of metadata. `None`
    /// when the file is absent or can't be opened (so the field is optional,
    /// not required, on the wire — omitted entirely, matching the TS
    /// `Schema.optional`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) table_count: Option<u64>,
    /// Last-modified time as an RFC 3339 string, or `None` when the file is
    /// absent or its mtime is unavailable (omitted from the wire when absent).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) modified_at: Option<String>,
    /// Whether the database is scheduled for deletion at the next startup (a
    /// pending-deletion marker exists). It still exists/serves until then, so the
    /// UI shows it as "scheduled — restart to finish" rather than gone.
    pub(crate) pending_deletion: bool,
}
