//! [`FhirR4StoreReadiness`]: whether the FHIR R4 store answers, asked
//! in-process.

use anyhow::Context;
use helios_persistence::backends::sqlite::SqliteBackend;
use helios_persistence::core::ResourceStorage;

/// The FHIR R4 store's readiness check: HFS's own
/// [`ResourceStorage::readiness_check`] on the sqlite backend, the check its
/// `/fhir-r4/_readiness` runs (a pooled connection and a `SELECT 1`), called
/// in-process rather than through the router. Cheap to clone: it shares the
/// backend's connection pool with the router [`crate::setup_fhir_r4`] built.
#[derive(Clone)]
pub struct FhirR4StoreReadiness {
    backend: SqliteBackend,
}

impl FhirR4StoreReadiness {
    pub(crate) fn new(backend: SqliteBackend) -> Self {
        Self { backend }
    }

    /// Check that the store hands out a connection and answers a query.
    ///
    /// # Errors
    ///
    /// Returns the backend's error when it can't.
    pub async fn check(&self) -> anyhow::Result<()> {
        self.backend
            .readiness_check()
            .await
            .context("the FHIR R4 store isn't ready")
    }
}
