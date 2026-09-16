pub(crate) mod capabilities;

use std::future::Future;

use axum::http::HeaderMap;

/// A decoded DICOM file — the raw bytes and their MIME type, extracted from a
/// FHIR DocumentReference attachment.
#[derive(Debug)]
pub(crate) struct DicomFile {
    pub bytes: Vec<u8>,
    pub content_type: String,
}

/// Failure modes for a DICOM file read.
#[derive(Debug)]
pub(crate) enum DicomFileError {
    /// No DocumentReference with this id, or its attachment carries no data.
    NotFound { id: String, detail: String },
    /// An infrastructure failure (HFS unreachable, JSON parse failure, base64
    /// decode failure, etc.).
    Infrastructure {
        context: &'static str,
        source: String,
    },
}

/// The store port for reading DICOM file bytes. The single implementation
/// delegates to HFS in-process (see [`crate::hfs::HfsDicomFileStore`]); the
/// trait exists so the capability is testable against a fake.
///
/// `caller_headers` carries the original request's headers — forwarded into HFS
/// so its bearer-JWT + SMART v2 scope enforcement stays in the path.
pub(crate) trait DicomFileStore: Clone + Send + Sync + 'static {
    fn get_file(
        &self,
        id: &str,
        caller_headers: &HeaderMap,
    ) -> impl Future<Output = Result<DicomFile, DicomFileError>> + Send;
}

#[cfg(test)]
pub(crate) mod test_fake {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use axum::http::HeaderMap;

    use super::{DicomFile, DicomFileError, DicomFileStore};

    #[derive(Clone, Default)]
    pub(crate) struct FakeDicomFileStore {
        files: Arc<Mutex<HashMap<String, DicomFile>>>,
    }

    impl FakeDicomFileStore {
        pub(crate) fn seed(&self, id: &str, bytes: Vec<u8>, content_type: &str) {
            self.files.lock().expect("lock").insert(
                id.to_owned(),
                DicomFile {
                    bytes,
                    content_type: content_type.to_owned(),
                },
            );
        }
    }

    impl DicomFileStore for FakeDicomFileStore {
        async fn get_file(
            &self,
            id: &str,
            _caller_headers: &HeaderMap,
        ) -> Result<DicomFile, DicomFileError> {
            self.files
                .lock()
                .expect("lock")
                .remove(id)
                .ok_or_else(|| DicomFileError::NotFound {
                    id: id.to_owned(),
                    detail: format!("DocumentReference/{id} not found"),
                })
        }
    }
}
