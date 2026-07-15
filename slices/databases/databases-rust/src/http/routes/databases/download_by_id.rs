//! `GET /databases/{id}` — download a database as a consistent SQLite snapshot.

use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::header::{CONTENT_DISPOSITION, CONTENT_TYPE};
use axum::http::HeaderValue;
use axum::response::{IntoResponse, Response};
use futures_core::Stream;
use tokio::fs::File;
use tokio_util::io::ReaderStream;

use crate::domain::DatabaseError;
use crate::files::snapshot_to_temp;
use crate::http::errors::DatabaseNotFoundBody;
use crate::http::state::DatabasesState;

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
        (status = 404, description = "No database has this id, or it doesn't exist yet", body = DatabaseNotFoundBody),
    ),
)]
pub(crate) async fn handle_download_database(
    State(state): State<Arc<DatabasesState>>,
    Path(id): Path<String>,
) -> Result<Response, DatabaseError> {
    let (descriptor, path) = state
        .existing(&id)
        .ok_or_else(|| DatabaseError::NotFound { id: id.clone() })?;
    // Own the filename before the await (the descriptor borrows `state`).
    let filename = descriptor.id.clone();

    let temp_path = tokio::task::spawn_blocking(move || snapshot_to_temp(&path))
        .await
        .map_err(|error| DatabaseError::infrastructure("snapshot task panicked", error))??;

    let file = File::open(&temp_path)
        .await
        .map_err(|error| DatabaseError::infrastructure("open snapshot", error))?;
    let body = Body::from_stream(TempFileStream::new(file, temp_path));

    // The filename is a catalogue id, enforced header-safe (ASCII alphanumeric
    // plus `.-_`, non-empty) at `DatabasesState::new`, so it never needs quote
    // escaping and this `expect` documents that now-enforced invariant.
    let disposition = HeaderValue::from_str(&format!("attachment; filename=\"{filename}\""))
        .expect("catalogue id is header-safe (enforced in DatabasesState::new)");
    let headers = [
        (
            CONTENT_TYPE,
            HeaderValue::from_static("application/vnd.sqlite3"),
        ),
        (CONTENT_DISPOSITION, disposition),
    ];
    Ok((headers, body).into_response())
}

/// A response-body stream over the temporary snapshot file that unlinks it once
/// the stream is dropped — after the body drains, or when the client disconnects
/// mid-download. Lives here because [`handle_download_database`] is its only
/// consumer.
struct TempFileStream {
    inner: Option<ReaderStream<File>>,
    temp_path: PathBuf,
}

impl TempFileStream {
    fn new(file: File, temp_path: PathBuf) -> Self {
        Self {
            inner: Some(ReaderStream::new(file)),
            temp_path,
        }
    }
}

impl Stream for TempFileStream {
    type Item = std::io::Result<Bytes>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        // `Self` is `Unpin` (every field is), so `get_mut` is sound.
        let this = self.get_mut();
        match this.inner.as_mut() {
            Some(inner) => Pin::new(inner).poll_next(cx),
            None => Poll::Ready(None),
        }
    }
}

impl Drop for TempFileStream {
    fn drop(&mut self) {
        // Drop the reader (closing the OS file handle) before unlinking — required
        // on Windows, harmless on Unix.
        self.inner = None;
        let _ = std::fs::remove_file(&self.temp_path);
    }
}
