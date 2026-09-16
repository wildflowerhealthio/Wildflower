pub(crate) mod capabilities;

use std::future::Future;

use bytes::Bytes;

/// A decoded DICOM file — raw bytes and their MIME type.
#[derive(Debug)]
pub(crate) struct DicomFile {
    pub bytes: Bytes,
    pub content_type: String,
}

/// Failure modes for a DICOM file read.
#[derive(Debug)]
pub(crate) enum DicomFileError {
    /// No DocumentReference with this id, or its attachment carries no data.
    NotFound { id: String, detail: String },
    /// The caller's token lacks the scopes required by HFS.
    Forbidden { id: String, detail: String },
    /// An infrastructure failure (HFS unreachable, JSON parse failure, base64
    /// decode failure, etc.).
    Infrastructure {
        context: &'static str,
        source: String,
    },
}

/// The store port for reading DICOM file bytes. The trait exists so the
/// capability is testable against a fake.
pub(crate) trait DicomFileStore: Clone + Send + Sync + 'static {
    fn get_file(
        &self,
        id: &str,
        auth_token: &str,
    ) -> impl Future<Output = Result<DicomFile, DicomFileError>> + Send;
}

#[cfg(test)]
pub(crate) mod test_fake {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use bytes::Bytes;

    use super::{DicomFile, DicomFileError, DicomFileStore};

    #[derive(Clone, Default)]
    pub(crate) struct FakeDicomFileStore {
        files: Arc<Mutex<HashMap<String, DicomFile>>>,
    }

    impl FakeDicomFileStore {
        pub(crate) fn seed(&self, id: &str, bytes: impl Into<Bytes>, content_type: &str) {
            self.files.lock().expect("lock").insert(
                id.to_owned(),
                DicomFile {
                    bytes: bytes.into(),
                    content_type: content_type.to_owned(),
                },
            );
        }
    }

    impl DicomFileStore for FakeDicomFileStore {
        async fn get_file(&self, id: &str, _auth_token: &str) -> Result<DicomFile, DicomFileError> {
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
