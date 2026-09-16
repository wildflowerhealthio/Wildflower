use axum::http::HeaderMap;
use scopes_rust::{
    ContextLevel, FhirResourceScope, Permission, ResourceType, Scope,
};

use crate::domain::{DicomFile, DicomFileError, DicomFileStore};

pub(crate) fn dicom_file_reader_scopes() -> Vec<Scope> {
    vec![Scope::FhirResource(FhirResourceScope {
        context: ContextLevel::User,
        resource: ResourceType::Known("DocumentReference".to_owned()),
        permission: Permission::READ,
    })]
}

pub(crate) struct DicomFileReader<S: DicomFileStore> {
    store: S,
}

impl<S: DicomFileStore> DicomFileReader<S> {
    pub(crate) fn new(store: S) -> Self {
        Self { store }
    }

    pub(crate) async fn get_file(
        &self,
        id: &str,
        caller_headers: &HeaderMap,
    ) -> Result<DicomFile, DicomFileError> {
        self.store.get_file(id, caller_headers).await
    }
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderMap;

    use super::*;
    use crate::domain::test_fake::FakeDicomFileStore;

    #[tokio::test]
    async fn reader_returns_seeded_file() {
        let store = FakeDicomFileStore::default();
        store.seed("doc-1", vec![0xDE, 0xAD], "application/dicom");
        let reader = DicomFileReader::new(store);
        let file = reader
            .get_file("doc-1", &HeaderMap::new())
            .await
            .expect("seeded file");
        assert_eq!(file.bytes, vec![0xDE, 0xAD]);
        assert_eq!(file.content_type, "application/dicom");
    }

    #[tokio::test]
    async fn reader_returns_not_found_for_unknown_id() {
        let store = FakeDicomFileStore::default();
        let reader = DicomFileReader::new(store);
        let err = reader
            .get_file("ghost", &HeaderMap::new())
            .await
            .expect_err("unknown id");
        assert!(matches!(err, DicomFileError::NotFound { .. }));
    }
}
