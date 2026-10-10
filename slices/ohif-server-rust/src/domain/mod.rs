pub(crate) mod capabilities;

use std::future::Future;

use bytes::Bytes;
use scope_capabilities_rust::MissingScopes;

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
    /// HFS refused the caller's token for this DocumentReference (or the
    /// request carried no bearer token to forward).
    Forbidden { id: String, detail: String },
    /// The caller's token doesn't cover the scope(s) the DICOM file reader
    /// requires — raised when the [`Scoped`](scope_capabilities_rust::Scoped)
    /// extractor rejects (via `From<MissingScopes>`). Rendered as the shared
    /// `403 InsufficientScope` body naming the rendered `missing_scopes`.
    InsufficientScope { missing_scopes: Vec<String> },
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

/// The [`Scoped`](scope_capabilities_rust::Scoped) extractor's rejection — the
/// caller's token doesn't cover the capability's required scopes — becomes
/// [`InsufficientScope`](DicomFileError::InsufficientScope), so it reaches the wire
/// through this error's rendering like any other failure.
impl From<MissingScopes> for DicomFileError {
    fn from(missing: MissingScopes) -> Self {
        DicomFileError::InsufficientScope {
            missing_scopes: missing.into_rendered(),
        }
    }
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
