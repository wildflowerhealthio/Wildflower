use std::sync::Arc;

use scope_capabilities_rust::{FixedScopeCapability, ScopeClaims};
use scopes_rust::Scope;

use super::state::OhifServerState;
use crate::domain::capabilities::{dicom_file_reader_scopes, DicomFileReader};
use crate::hfs::HfsDicomFileStore;

pub(crate) type LiveDicomFileReader = DicomFileReader<HfsDicomFileStore>;

impl FixedScopeCapability for LiveDicomFileReader {
    type State = Arc<OhifServerState>;
    type Claims = ScopeClaims;

    fn required_scopes() -> Vec<Scope> {
        dicom_file_reader_scopes()
    }

    fn build(state: Arc<OhifServerState>) -> Self {
        DicomFileReader::new(state.store.clone())
    }
}
