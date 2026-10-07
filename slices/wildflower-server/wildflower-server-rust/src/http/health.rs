//! The server's `/health` checks: what [`health_router`](shared_structures_rust::health_check::health_router)
//! serves at `GET /health`, a functional breakdown in three checks.
//!
//! - **`fhir-r4`** — the FHIR R4 surface: HFS's own store readiness check
//!   ([`FhirR4StoreReadiness`]), called in-process.
//! - **`server`** — everything else the server serves rides
//!   `wildflower.sqlite`'s diesel pool: a pooled connection answering
//!   `SELECT 1`.
//! - **`connectivity`** — the tunnel's own [`TunnelConnectivity`]: `pass`
//!   while it is normal, `warn` while it is degraded. It never fails: a server
//!   answering `/health` is connected, and through the relay a down tunnel
//!   means no answer at all.
//!
//! Each is cheap, in-process and touches no network. A check that errors or
//! outlasts [`CHECK_TIMEOUT`] fails; the reason goes to the log, never into
//! the public report.

use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::Context;
use chrono::Utc;
use diesel::RunQueryDsl;
use emr_rust::FhirR4StoreReadiness;
use persistence_rust::DieselPool;
use shared_structures_rust::health_check::{
    ComponentType, HealthCheck, HealthCheckService, HealthReport, HealthStatus,
};
use tokio::sync::watch;
use tunnel_rust::TunnelConnectivity;

/// How long one check may take before it fails.
const CHECK_TIMEOUT: Duration = Duration::from_secs(1);

/// The `/health` check of the FHIR R4 surface.
const FHIR_R4_CHECK: &str = "fhir-r4";

/// The `/health` check of everything else the server serves.
const SERVER_CHECK: &str = "server";

/// The `/health` check of the tunnel carrying the server's remote traffic.
const CONNECTIVITY_CHECK: &str = "connectivity";

/// The server's [`HealthCheckService`]: the `fhir-r4`, `server` and
/// `connectivity` checks.
pub(crate) struct ServerHealthChecks {
    pub(crate) fhir_r4_store: FhirR4StoreReadiness,
    pub(crate) wildflower_db: DieselPool,
    /// The tunnel daemon's [`TunnelConnectivity`]
    /// ([`TunnelDaemon::connectivity`](tunnel_rust::TunnelDaemon::connectivity)).
    pub(crate) tunnel_connectivity: watch::Receiver<TunnelConnectivity>,
}

#[async_trait::async_trait]
impl HealthCheckService for ServerHealthChecks {
    async fn check(&self) -> HealthReport {
        let (fhir_r4, server) = tokio::join!(
            check_fhir_r4(&self.fhir_r4_store),
            check_server(self.wildflower_db.clone(), CHECK_TIMEOUT),
        );
        let connectivity = check_connectivity(*self.tunnel_connectivity.borrow());
        HealthReport::from_checks(BTreeMap::from([
            (FHIR_R4_CHECK.to_owned(), vec![fhir_r4]),
            (SERVER_CHECK.to_owned(), vec![server]),
            (CONNECTIVITY_CHECK.to_owned(), vec![connectivity]),
        ]))
    }
}

/// The `connectivity` check: `pass` while the tunnel's connectivity is
/// normal, `warn` while it is degraded.
fn check_connectivity(tunnel_connectivity: TunnelConnectivity) -> HealthCheck {
    let status = match tunnel_connectivity {
        TunnelConnectivity::Normal => HealthStatus::Pass,
        TunnelConnectivity::Degraded => HealthStatus::Warn,
    };
    HealthCheck {
        component_type: ComponentType::Component,
        status,
        time: Utc::now(),
    }
}

/// The `fhir-r4` check: the FHIR R4 store's readiness, within
/// [`CHECK_TIMEOUT`]. The readiness check runs on the blocking pool, so the
/// timeout fires even while HFS's pool checkout is parked.
async fn check_fhir_r4(fhir_r4_store: &FhirR4StoreReadiness) -> HealthCheck {
    let outcome = tokio::time::timeout(CHECK_TIMEOUT, fhir_r4_store.check())
        .await
        .unwrap_or_else(|_elapsed| Err(anyhow::anyhow!("no answer within {CHECK_TIMEOUT:?}")));
    health_check(FHIR_R4_CHECK, ComponentType::Component, outcome)
}

/// The `server` check: a connection from `wildflower_db` within `timeout`,
/// answering `SELECT 1`. r2d2 checks out connections synchronously, so it
/// runs on the blocking pool.
async fn check_server(wildflower_db: DieselPool, timeout: Duration) -> HealthCheck {
    let outcome = tokio::task::spawn_blocking(move || {
        let mut connection = wildflower_db
            .get_timeout(timeout)
            .context("no wildflower.sqlite connection")?;
        diesel::sql_query("SELECT 1")
            .execute(&mut connection)
            .context("wildflower.sqlite didn't answer SELECT 1")?;
        anyhow::Ok(())
    })
    .await
    .context("the wildflower.sqlite check panicked")
    .and_then(|outcome| outcome);
    health_check(SERVER_CHECK, ComponentType::System, outcome)
}

/// The check object for `outcome`, logging why it failed.
fn health_check(
    check_name: &str,
    component_type: ComponentType,
    outcome: anyhow::Result<()>,
) -> HealthCheck {
    let status = match outcome {
        Ok(()) => HealthStatus::Pass,
        Err(error) => {
            tracing::warn!(check = check_name, error = %format!("{error:#}"), "/health check failed");
            HealthStatus::Fail
        }
    };
    HealthCheck {
        component_type,
        status,
        time: Utc::now(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connectivity_passes_while_normal_and_warns_while_degraded() {
        let status_of = |tunnel_connectivity| {
            let check = check_connectivity(tunnel_connectivity);
            (check.component_type, check.status)
        };
        assert_eq!(
            status_of(TunnelConnectivity::Normal),
            (ComponentType::Component, HealthStatus::Pass)
        );
        assert_eq!(
            status_of(TunnelConnectivity::Degraded),
            (ComponentType::Component, HealthStatus::Warn)
        );
    }

    #[tokio::test]
    async fn the_server_check_passes_on_an_open_pool() {
        let wildflower_db = persistence_rust::open_in_memory_pool().expect("pool");
        let check = check_server(wildflower_db, CHECK_TIMEOUT).await;
        assert_eq!(
            (check.component_type, check.status),
            (ComponentType::System, HealthStatus::Pass)
        );
    }

    /// Every connection checked out elsewhere: no connection in time fails.
    #[tokio::test]
    async fn the_server_check_fails_on_an_exhausted_pool() {
        let wildflower_db = persistence_rust::open_in_memory_pool().expect("pool");
        let held: Vec<_> = (0..wildflower_db.max_size())
            .map(|_| wildflower_db.get().expect("a connection"))
            .collect();
        let check = check_server(wildflower_db.clone(), Duration::from_millis(50)).await;
        assert_eq!(check.status, HealthStatus::Fail);
        drop(held);
        let check = check_server(wildflower_db, Duration::from_millis(50)).await;
        assert_eq!(check.status, HealthStatus::Pass, "it recovers");
    }
}
