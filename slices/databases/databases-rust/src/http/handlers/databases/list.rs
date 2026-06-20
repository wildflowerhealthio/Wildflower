//! `GET /databases` — metadata for every catalogued database.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;

use crate::catalog::CATALOG;
use crate::http::state::DatabasesState;
use crate::metadata::DatabaseMetadata;

/// `GET /databases` — list every catalogued database with its on-disk metadata
/// (existence, size, table count, last-modified). Infallible: a missing or
/// unreadable file reports `exists: false` rather than failing the listing.
#[utoipa::path(
    get,
    path = "/databases",
    responses(
        (status = 200, description = "Metadata for every host database", body = [DatabaseMetadata]),
    ),
)]
pub(crate) async fn handle_list_databases(
    State(state): State<Arc<DatabasesState>>,
) -> Json<Vec<DatabaseMetadata>> {
    let entries = CATALOG
        .iter()
        .map(|descriptor| DatabaseMetadata::read(descriptor, &state.path_for(descriptor)))
        .collect();
    Json(entries)
}
