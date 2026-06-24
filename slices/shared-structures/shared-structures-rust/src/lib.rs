pub mod bridge;
pub mod server_runtime_config;

pub use server_runtime_config::ServerRuntimeConfig;

#[cfg(feature = "http-errors")]
pub mod http_errors;

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

/// Forwarding-header provenance: `request_provenance` (Loopback vs Forwarded)
/// and the rendered `served_origin_for`. One source of truth for the
/// `x-public-origin` + `x-forwarded-proto` contract the trusted front sets on
/// relayed requests, so gatekeeper-rust (token issuer URLs, discovery doc)
/// and apps-rust (launch redirect target) can't drift apart on what counts as
/// a forwarded request. Behind the `served-origin` feature so non-HTTP crates
/// don't pull `axum`.
#[cfg(feature = "served-origin")]
pub mod served_origin;
