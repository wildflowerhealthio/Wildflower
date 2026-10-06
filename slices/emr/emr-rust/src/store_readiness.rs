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
    /// HFS's sqlite readiness check checks a connection out of its r2d2 pool
    /// synchronously, parking for up to the pool's connection timeout when
    /// the pool is exhausted, so it runs on the blocking pool: the caller's
    /// task stays cancellable, and a stuck store never holds an async worker.
    ///
    /// # Errors
    ///
    /// Returns the backend's error when it can't, or when the check panicked.
    pub async fn check(&self) -> anyhow::Result<()> {
        let backend = self.backend.clone();
        let runtime = tokio::runtime::Handle::current();
        tokio::task::spawn_blocking(move || runtime.block_on(backend.readiness_check()))
            .await
            .context("the FHIR R4 store readiness check panicked")?
            .context("the FHIR R4 store isn't ready")
    }
}
