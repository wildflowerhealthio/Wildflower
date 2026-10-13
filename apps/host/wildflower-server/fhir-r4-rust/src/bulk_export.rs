//! HFS's bulk `$export`, run in-process: the job store is the health data's
//! own sqlite file, each job's NDJSON parts are written under
//! [`FhirR4Config::bulk_export_dir`](crate::FhirR4Config::bulk_export_dir) and
//! served back through HFS's `/export-file` route, and [`BulkExportWorker`]
//! runs the jobs `$export` accepts and deletes them once they expire.
//!
//! helios-rest only accepts and tracks jobs; the HFS binary runs the worker and
//! the cleanup beside its router, so an embedding has to run them itself.

use std::sync::Arc;
use std::time::Duration;

use helios_persistence::backends::local_fs::LocalFsOutputStore;
use helios_persistence::backends::sqlite::SqliteBackend;
use helios_persistence::core::{
    BulkExportStorage, DefaultExportWorker, ExportClaimStrategy, ExportOutputStore, WorkerId,
};
use helios_rest::bulk_export_auth::BearerScopeAuth;
use helios_rest::config::BulkExportConfig;
use helios_rest::BulkExportBundle;
use tokio_util::sync::CancellationToken;

/// How long the worker waits before looking for a job again when none is
/// waiting.
const IDLE_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// How many expired jobs one cleanup pass deletes.
const EXPIRED_JOBS_PER_SWEEP: u32 = 100;

/// The bulk-export subsystem HFS's router is built with: job state in
/// `sqlite_backend`, output in `output_store`, downloads authorized by HFS's
/// default rule (the job's owner, or a `system/*` scope, holding read on the
/// file's resource type).
pub(crate) fn bulk_export_bundle(
    sqlite_backend: Arc<SqliteBackend>,
    output_store: Arc<LocalFsOutputStore>,
) -> BulkExportBundle {
    BulkExportBundle {
        jobs: sqlite_backend,
        output: output_store,
        file_auth: Arc::new(BearerScopeAuth),
    }
}

/// Runs the bulk-export jobs HFS's `$export` accepts, one at a time, and
/// deletes each finished job's record and files once its output has outlived
/// the configured TTL. Built by [`crate::setup_fhir_r4`]; does nothing until
/// [`run`](Self::run).
pub struct BulkExportWorker {
    sqlite_backend: Arc<SqliteBackend>,
    output_store: Arc<LocalFsOutputStore>,
    bulk_export_config: BulkExportConfig,
}

impl BulkExportWorker {
    pub(crate) fn new(
        sqlite_backend: Arc<SqliteBackend>,
        output_store: Arc<LocalFsOutputStore>,
        bulk_export_config: BulkExportConfig,
    ) -> Self {
        Self {
            sqlite_backend,
            output_store,
            bulk_export_config,
        }
    }

    /// Run jobs and sweep expired ones until `shutdown` is cancelled. A job
    /// running at shutdown hands its lease back, so the next start picks it up
    /// again at once.
    ///
    /// A failed claim, run or sweep is logged and retried on the next pass: one
    /// export failing must not stop the server that serves everything else.
    pub async fn run(self, shutdown: CancellationToken) {
        tokio::join!(
            self.run_jobs(shutdown.clone()),
            self.sweep_expired_jobs(shutdown)
        );
    }

    async fn run_jobs(&self, shutdown: CancellationToken) {
        let config = &self.bulk_export_config;
        let worker_id = WorkerId::random();
        let worker = DefaultExportWorker::new(
            self.sqlite_backend.clone(),
            self.sqlite_backend.clone(),
            self.output_store.clone(),
            worker_id.clone(),
        )
        .with_shutdown(shutdown.clone())
        .with_heartbeat_interval(Duration::from_secs(config.heartbeat_interval_secs))
        .with_exclude_since_newly_added(config.since_newly_added == "exclude");
        let lease_duration = Duration::from_secs(config.lease_duration_secs);
        while !shutdown.is_cancelled() {
            let claimed = self
                .sqlite_backend
                .claim_next(&worker_id, lease_duration, config.max_attempts)
                .await;
            match claimed {
                Ok(Some(lease)) => {
                    if let Err(error) = worker.run_job(lease).await {
                        tracing::error!("bulk export job failed: {error}");
                    }
                }
                Ok(None) => wait_or_shutdown(&shutdown, IDLE_POLL_INTERVAL).await,
                Err(error) => {
                    tracing::error!("failed to claim a bulk export job: {error}");
                    wait_or_shutdown(&shutdown, IDLE_POLL_INTERVAL).await;
                }
            }
        }
    }

    async fn sweep_expired_jobs(&self, shutdown: CancellationToken) {
        let config = &self.bulk_export_config;
        let output_ttl = Duration::from_secs(config.output_ttl_secs);
        let cleanup_interval = Duration::from_secs(config.cleanup_interval_secs);
        while !shutdown.is_cancelled() {
            if let Err(error) = self.delete_expired_jobs(output_ttl).await {
                tracing::error!("failed to delete expired bulk exports: {error}");
            }
            wait_or_shutdown(&shutdown, cleanup_interval).await;
        }
    }

    /// Delete the files, then the record, of each job whose output is older
    /// than `output_ttl`. Files go first: a record deleted before its files
    /// would leave nothing to find them by.
    async fn delete_expired_jobs(
        &self,
        output_ttl: Duration,
    ) -> helios_persistence::error::StorageResult<()> {
        let expired_jobs = self
            .sqlite_backend
            .list_expired_exports(chrono::Utc::now(), output_ttl, EXPIRED_JOBS_PER_SWEEP)
            .await?;
        for expired_job in expired_jobs {
            self.output_store
                .delete_job_outputs(&expired_job.tenant, &expired_job.job_id)
                .await?;
            self.sqlite_backend
                .delete_export(&expired_job.tenant, &expired_job.job_id)
                .await?;
        }
        Ok(())
    }
}

async fn wait_or_shutdown(shutdown: &CancellationToken, interval: Duration) {
    tokio::select! {
        () = shutdown.cancelled() => {}
        () = tokio::time::sleep(interval) => {}
    }
}

#[cfg(test)]
mod tests {
    use helios_fhir::FhirVersion;
    use helios_persistence::core::{
        BulkExportStorage, ExportLevel, ExportRequest, ExportStatus, ResourceStorage,
        StartExportInput,
    };
    use helios_persistence::tenant::TenantContext;

    use super::*;

    /// A job the worker ran to completion writes its file; once its output
    /// has outlived the TTL, the sweep deletes both its record and its files.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_finished_export_is_deleted_with_its_files_once_expired() {
        let bulk_export_dir = tempfile::tempdir().expect("a temp export dir");
        let sqlite_backend = Arc::new(SqliteBackend::in_memory().expect("an in-memory backend"));
        sqlite_backend
            .init_schema()
            .expect("the schema initializes");
        let tenant = TenantContext::system();
        sqlite_backend
            .create(
                &tenant,
                "Patient",
                serde_json::json!({ "resourceType": "Patient" }),
                FhirVersion::R4,
            )
            .await
            .expect("a Patient to export");
        let job_id = sqlite_backend
            .start_export(
                &tenant,
                StartExportInput {
                    request: ExportRequest::new(ExportLevel::System),
                    transaction_time: chrono::Utc::now(),
                    request_url: "https://example.invalid/$export".to_string(),
                    owner_subject: None,
                    fhir_version: FhirVersion::R4,
                },
            )
            .await
            .expect("the export is accepted");
        let worker = BulkExportWorker::new(
            sqlite_backend.clone(),
            Arc::new(LocalFsOutputStore::new(
                bulk_export_dir.path(),
                "https://example.invalid",
            )),
            BulkExportConfig::default(),
        );

        let shutdown = CancellationToken::new();
        tokio::time::timeout(Duration::from_secs(30), async {
            let wait_for_completion = async {
                loop {
                    let progress = sqlite_backend
                        .get_export_status(&tenant, &job_id)
                        .await
                        .expect("the job is tracked");
                    if progress.status == ExportStatus::Complete {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                shutdown.cancel();
            };
            tokio::join!(worker.run_jobs(shutdown.clone()), wait_for_completion);
        })
        .await
        .expect("the job runs to completion in time");
        let job_dir = bulk_export_dir
            .path()
            .join(tenant.tenant_id().as_str())
            .join(job_id.as_str());
        assert!(
            std::fs::read_dir(&job_dir)
                .expect("the job's folder is written")
                .next()
                .is_some(),
            "the job's file is written"
        );

        worker
            .delete_expired_jobs(Duration::ZERO)
            .await
            .expect("the sweep succeeds");

        assert!(
            sqlite_backend
                .get_export_status(&tenant, &job_id)
                .await
                .is_err(),
            "the job's record is deleted"
        );
        assert!(!job_dir.exists(), "the job's files are deleted");
    }
}
