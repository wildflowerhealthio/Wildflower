pub mod bridge;
pub mod server_runtime_config;
pub mod test_utils;

pub use server_runtime_config::ServerRuntimeConfig;

mod on_device_webview_handle;
pub use on_device_webview_handle::OnDeviceWebviewHandle;

/// Canonical, build-time-fixed `iss` claim baked into every JWT minted by
/// gatekeeper and the value HFS validates against on every FHIR request.
///
/// A single, deliberate constant: Wildflower is single-tenant for now, so there
/// is intentionally **no** per-deployment override. Pinning a stable `iss` lets
/// one `expected_issuer` accept both loopback- and tunnel-minted tokens with no
/// branching at mint or validation time; a multi-tenant issuer is deferred until
/// a second tenant justifies it. See `docs/Origins/Explanation.md`.
pub const CANONICAL_ISSUER: &str = "https://wildflowerhealth.io";

#[cfg(feature = "http-errors")]
pub mod http_errors;

#[cfg(feature = "openapi-snapshot")]
pub mod openapi_snapshot;

/// Merge several slice `OpenApi` documents into one and serve it as an
/// interactive Scalar API reference (the host's unified `/docs`). Behind the
/// `openapi-docs` feature so only the host binary pulls `utoipa-scalar`.
#[cfg(feature = "openapi-docs")]
pub mod openapi_docs;

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

/// Forwarding-header provenance: `request_provenance` and `served_base_url_for`,
/// the single source of truth for a request's served base URL (see the module
/// and `docs/Origins/Explanation.md`). Behind the `served-origin` feature so
/// non-HTTP crates don't pull `axum`.
#[cfg(feature = "served-origin")]
pub mod served_origin;

/// The `<id>.<public_host>` subdomain shape shared by the launch-redirect
/// producer and the subdomain-dispatch consumer (see the module and
/// `docs/Origins/Explanation.md`). Behind the `subdomain-url` feature; pure
/// string code, no extra deps.
#[cfg(feature = "subdomain-url")]
pub mod subdomain_host;
