//! A response body that streams a temporary snapshot file and removes it once
//! the stream is dropped — after the body drains, or when the client
//! disconnects mid-download.

use std::path::PathBuf;
use std::pin::Pin;
use std::task::{Context, Poll};

use axum::body::Bytes;
use futures_core::Stream;
use tokio::fs::File;
use tokio_util::io::ReaderStream;

/// Streams `file` and unlinks `temp_path` on drop. The inner reader is taken
/// (and so the file handle closed) *before* the unlink — required on Windows,
/// harmless on Unix.
pub(crate) struct TempFileStream {
    inner: Option<ReaderStream<File>>,
    temp_path: PathBuf,
}

impl TempFileStream {
    pub(crate) fn new(file: File, temp_path: PathBuf) -> Self {
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
        // Drop the reader (closing the OS file handle) before unlinking.
        self.inner = None;
        let _ = std::fs::remove_file(&self.temp_path);
    }
}
