//! The wire metadata shape for a single database, plus the best-effort reads
//! that populate it. Everything here tolerates a missing or unreadable file:
//! a database the user has never created (or just deleted) reports
//! `exists: false` rather than failing the listing.

use std::path::Path;

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::OpenFlags;
use serde::Serialize;
use utoipa::ToSchema;

use crate::catalog::DatabaseDescriptor;

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
}

impl DatabaseMetadata {
    /// Read the metadata for `descriptor` at `path`. Never fails: a missing or
    /// unreadable file yields `exists: false` with zeroed/absent fields.
    pub(crate) fn read(descriptor: &DatabaseDescriptor, path: &Path) -> Self {
        let file_metadata = std::fs::metadata(path).ok();
        let exists = file_metadata.is_some();
        let size_bytes = file_metadata.as_ref().map_or(0, std::fs::Metadata::len);
        let modified_at = file_metadata
            .as_ref()
            .and_then(|m| m.modified().ok())
            .map(|time| DateTime::<Utc>::from(time).to_rfc3339_opts(SecondsFormat::Millis, true));
        let table_count = if exists {
            count_user_tables(path)
        } else {
            None
        };

        Self {
            id: descriptor.id.to_owned(),
            label: descriptor.label.to_owned(),
            description: descriptor.description.to_owned(),
            exists,
            size_bytes,
            table_count,
            modified_at,
        }
    }
}

/// Count the user tables (excluding SQLite's own `sqlite_*` bookkeeping) via a
/// throwaway read-only connection. Best-effort: any open/query failure (a
/// locked, corrupt, or non-SQLite file) collapses to `None` rather than failing
/// the whole listing.
fn count_user_tables(path: &Path) -> Option<u64> {
    let conn =
        rusqlite::Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get(0),
        )
        .ok()?;
    u64::try_from(count).ok()
}
