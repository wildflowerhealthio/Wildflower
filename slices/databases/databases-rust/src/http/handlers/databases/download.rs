//! `GET /databases/{id}` — download a database as a consistent SQLite snapshot.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::header::{CONTENT_DISPOSITION, CONTENT_TYPE};
use axum::http::HeaderValue;
use axum::response::{IntoResponse, Response};

use crate::files::snapshot_to_temp;
use crate::http::response_templates::HandlerError;
use crate::http::state::DatabasesState;
use crate::http::temp_file_stream::TempFileStream;

/// `GET /databases/{id}` — stream the database file as `application/vnd.sqlite3`
/// (a `VACUUM INTO` snapshot, so it's internally consistent even while the
/// owning slice is writing). Unknown ids and not-yet-created databases are
/// `404 DatabaseNotFound`.
///
/// The blocking snapshot + file IO runs on a blocking thread (`spawn_blocking`),
/// and the result is streamed from the temp file rather than buffered into
/// memory, so a large database neither stalls the async runtime nor spikes RSS
/// by its full size.
///
/// The body is binary, so this endpoint is documented here (utoipa) but is
/// intentionally absent from the `databases-core` Effect `HttpApi`: the React
/// client downloads it through the raw `HttpClient` to get the bytes, not the
/// generated JSON client. The spec-drift test scopes only the JSON endpoints.
#[utoipa::path(
    get,
    tag = "Management",
    path = "/databases/{id}",
    params(
        ("id" = String, Path, description = "Database resource id (filename), e.g. health-data.sqlite"),
    ),
    responses(
        (status = 200, description = "The database as a consistent SQLite snapshot", content_type = "application/vnd.sqlite3"),
        (status = 404, description = "No database has this id, or it doesn't exist yet", body = crate::http::response_templates::DatabaseNotFoundBody),
    ),
)]
pub(crate) async fn handle_download_database(
    State(state): State<Arc<DatabasesState>>,
    Path(id): Path<String>,
) -> Result<Response, HandlerError> {
    let Some((descriptor, path)) = state.existing(&id) else {
        return Err(HandlerError::NotFound { id });
    };
    // Own the filename before the await (the descriptor borrows `state`).
    let filename = descriptor.id.clone();

    let temp_path = tokio::task::spawn_blocking(move || snapshot_to_temp(&path))
        .await
        .map_err(|error| HandlerError::internal("snapshot task panicked", error))?
        .map_err(|error| HandlerError::internal("snapshot_database failed", error))?;

    let file = tokio::fs::File::open(&temp_path)
        .await
        .map_err(|error| HandlerError::internal("open snapshot failed", error))?;
    let body = Body::from_stream(TempFileStream::new(file, temp_path));

    // The filename is a fixed catalogue id (a bare `*.sqlite` filename), so it's
    // always header-safe; `expect` documents that invariant.
    let disposition = HeaderValue::from_str(&format!("attachment; filename=\"{filename}\""))
        .expect("catalogue id is a valid header value");
    let headers = [
        (
            CONTENT_TYPE,
            HeaderValue::from_static("application/vnd.sqlite3"),
        ),
        (CONTENT_DISPOSITION, disposition),
    ];
    Ok((headers, body).into_response())
}
