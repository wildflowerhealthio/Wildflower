//! The server's `/health` checks: what [`health_router`](wildflowerhealthio_shared_structures::health_check::health_router)
//! serves at `GET /health`, a functional breakdown in two checks.
//!
//! - **`server`** — everything else the server serves rides
//!   `wildflower.sqlite`'s diesel pool: a pooled connection answering
//!   `SELECT 1`.
//! - **`connectivity`** — the tunnel's own [`HealthStatus`]: reported
//!   as the tunnel publishes it. Nothing sets it to `warn` or `fail` yet, and
//!   through the relay a down tunnel means no answer at all.
//!
//! Each is cheap, in-process and touches no network. A check that errors or
//! outlasts [`CHECK_TIMEOUT`] fails; the reason goes to the log, never into
//! the public report.

use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::Context;
use chrono::Utc;
use diesel::RunQueryDsl;
use tokio::sync::watch;
use wildflowerhealthio_persistence::DieselPool;
use wildflowerhealthio_shared_structures::health_check::{
    ComponentType, HealthCheck, HealthCheckService, HealthReport, HealthStatus,
};

/// How long one check may take before it fails.
const CHECK_TIMEOUT: Duration = Duration::from_secs(1);

/// The `/health` check of everything else the server serves.
const SERVER_CHECK: &str = "server";

/// The `/health` check of the tunnel carrying the server's remote traffic.
const CONNECTIVITY_CHECK: &str = "connectivity";

/// The server's [`HealthCheckService`]: the `server` and `connectivity`
/// checks.
pub(crate) struct ServerHealthChecks {
    pub(crate) wildflower_db: DieselPool,
    /// The tunnel daemon's [`HealthStatus`]
    /// ([`TunnelDaemon::connectivity`](wildflowerhealthio_tunnel::TunnelDaemon::connectivity)).
    pub(crate) tunnel_connectivity: watch::Receiver<HealthStatus>,
}

#[async_trait::async_trait]
impl HealthCheckService for ServerHealthChecks {
    async fn check(&self) -> HealthReport {
        let server = check_server(self.wildflower_db.clone(), CHECK_TIMEOUT).await;
        let connectivity = check_connectivity(*self.tunnel_connectivity.borrow());
        HealthReport::from_checks(BTreeMap::from([
            (SERVER_CHECK.to_owned(), vec![server]),
            (CONNECTIVITY_CHECK.to_owned(), vec![connectivity]),
        ]))
    }
}

/// The `connectivity` check: the tunnel's own [`HealthStatus`], as published.
fn check_connectivity(tunnel_health: HealthStatus) -> HealthCheck {
    HealthCheck {
        component_type: ComponentType::Component,
        status: tunnel_health,
        time: Utc::now(),
    }
}

/// The `server` check: a connection from `wildflower_db` within `timeout`,
/// answering `SELECT 1`. r2d2 checks out connections synchronously, so it
/// runs on the blocking pool.
async fn check_server(wildflower_db: DieselPool, timeout: Duration) -> HealthCheck {
    let blocking = tokio::task::spawn_blocking(move || {
        let mut connection = wildflower_db
            .get_timeout(timeout)
            .context("no wildflower.sqlite connection")?;
        diesel::sql_query("SELECT 1")
            .execute(&mut connection)
            .context("wildflower.sqlite didn't answer SELECT 1")?;
        anyhow::Ok(())
    });
    // The pool bounds the checkout, not the query: bound the whole check, so a
    // connection that hangs on `SELECT 1` still fails within `timeout`.
    let outcome = match tokio::time::timeout(timeout, blocking).await {
        Ok(joined) => joined
            .context("the wildflower.sqlite check panicked")
            .and_then(|outcome| outcome),
        Err(_elapsed) => Err(anyhow::anyhow!("no answer within {timeout:?}")),
    };
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
    fn connectivity_reports_the_tunnels_health() {
        for status in [HealthStatus::Pass, HealthStatus::Warn, HealthStatus::Fail] {
            let check = check_connectivity(status);
            assert_eq!(
                (check.component_type, check.status),
                (ComponentType::Component, status)
            );
        }
    }

    #[tokio::test]
    async fn the_server_check_passes_on_an_open_pool() {
        let wildflower_db = wildflowerhealthio_persistence::open_in_memory_pool().expect("pool");
        let check = check_server(wildflower_db, CHECK_TIMEOUT).await;
        assert_eq!(
            (check.component_type, check.status),
            (ComponentType::System, HealthStatus::Pass)
        );
    }

    /// Every connection checked out elsewhere: no connection in time fails.
    #[tokio::test]
    async fn the_server_check_fails_on_an_exhausted_pool() {
        let wildflower_db = wildflowerhealthio_persistence::open_in_memory_pool().expect("pool");
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
