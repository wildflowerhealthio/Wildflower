//! `GET /databases` — metadata for every catalogued database.

use axum::Json;

use crate::domain::capabilities::Scoped;
use crate::domain::{DatabaseError, DatabaseMetadata};
use crate::live_bindings::LiveDatabasesReader;

/// `GET /databases` — list every catalogued database with its on-disk metadata
/// (existence, size, table count, last-modified). Authenticated-only: listing
/// exposes names/sizes, not contents, so it needs no per-database scope — the
/// [`Scoped<LiveDatabasesReader>`] gate is satisfied by any valid session. The
/// per-database reads are **best-effort** (a missing or unreadable file reports
/// `exists: false`) and run on a blocking thread inside the facade.
#[utoipa::path(
    get,
    tag = "Management",
    path = "/databases",
    responses(
        (status = 200, description = "Metadata for every host database", body = [DatabaseMetadata]),
    ),
)]
pub(crate) async fn handle_list_databases(
    reader: Scoped<LiveDatabasesReader>,
) -> Result<Json<Vec<DatabaseMetadata>>, DatabaseError> {
    Ok(Json(reader.list().await?))
}
