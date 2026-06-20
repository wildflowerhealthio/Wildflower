pub mod bridge;
pub mod server_runtime_config;

pub use server_runtime_config::ServerRuntimeConfig;

#[cfg(feature = "openapi-snapshot")]
pub mod openapi_snapshot;

/// The tunnel service contract (`TunnelService` + state types) the tunnel slice
/// implements and the apps slice consumes. Behind the `tunnel-service` feature
/// so the lean default build stays free of `tokio`/`async-trait`.
#[cfg(feature = "tunnel-service")]
pub mod tunnel_service;

/// The health-check service contract (`HealthCheckService`) + a reusable
/// `/health` router. Behind the `health-check` feature so the lean default build
/// stays free of `axum`/`async-trait`.
#[cfg(feature = "health-check")]
pub mod health_check;
