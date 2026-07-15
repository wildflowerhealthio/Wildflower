//! `GET /databases` — metadata for every catalogued database.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;

use crate::domain::DatabaseError;
use crate::http::state::DatabasesState;
use crate::metadata::DatabaseMetadata;

/// `GET /databases` — list every catalogued database with its on-disk metadata
/// (existence, size, table count, last-modified). The per-database reads are
/// **best-effort**: a missing or unreadable file reports `exists: false` rather
/// than failing the listing.
///
/// Each read does blocking fs stat plus a throwaway rusqlite `count(*)`, so the
/// whole loop runs on a blocking thread (`spawn_blocking`) rather than stalling
/// the async runtime — matching the download handler's sibling. Only a
/// `spawn_blocking` join failure (a worker panic) can surface an error here.
#[utoipa::path(
    get,
    tag = "Management",
    path = "/databases",
    responses(
        (status = 200, description = "Metadata for every host database", body = [DatabaseMetadata]),
    ),
)]
pub(crate) async fn handle_list_databases(
    State(state): State<Arc<DatabasesState>>,
) -> Result<Json<Vec<DatabaseMetadata>>, DatabaseError> {
    let entries = tokio::task::spawn_blocking(move || {
        state
            .databases()
            .iter()
            .map(|descriptor| DatabaseMetadata::read(descriptor, &state.path_for(descriptor)))
            .collect()
    })
    .await
    .map_err(|error| DatabaseError::infrastructure("list metadata task panicked", error))?;
    Ok(Json(entries))
}
