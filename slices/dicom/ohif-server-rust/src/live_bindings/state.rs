use crate::hfs::HfsDicomFileStore;

pub struct OhifServerState {
    pub(crate) store: HfsDicomFileStore,
}

impl OhifServerState {
    #[must_use]
    pub(crate) fn new(store: HfsDicomFileStore) -> Self {
        Self { store }
    }
}
