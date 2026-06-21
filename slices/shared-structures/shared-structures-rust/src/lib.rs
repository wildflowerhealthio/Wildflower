pub mod bridge;
pub mod server_runtime_config;
pub mod test_utils;

pub use server_runtime_config::ServerRuntimeConfig;

mod on_device_webview_handle;
pub use on_device_webview_handle::OnDeviceWebviewHandle;

/// Canonical, build-time-fixed `iss` claim baked into every JWT minted by
/// gatekeeper and the value HFS validates against on every FHIR request.
///
/// Hardcoded for now: gatekeeper used to derive `iss` from the per-request
/// origin, which meant a single `HFS_AUTH_ISSUER` couldn't accept both
/// loopback-minted owner tokens (`http://127.0.0.1:...`) and tunnel-minted
/// SMART app tokens (`https://<host>`). Pinning to a stable string skips
/// the loopback-vs-tunnel branching at mint time and at validation time.
/// SMART clients that compare a discovered `issuer` to the JWT's `iss` will
/// see the same string in both places (the discovery override emits this
/// constant too).
pub const CANONICAL_ISSUER: &str = "https://wildflowerhealth.io";

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
/// and the rendered `served_origin_for`. One source of truth for the `Forwarded`
/// header (RFC 7239) the trusted front sets on relayed requests, so
/// gatekeeper-rust (token issuer URLs, discovery doc) and apps-rust (launch
/// redirect target) can't drift apart on what counts as a forwarded request.
/// Behind the `served-origin` feature so non-HTTP crates don't pull `axum`.
#[cfg(feature = "served-origin")]
pub mod served_origin;

/// The `<id>.<public_host>` subdomain shape — one definition shared by the
/// apps slice's internal-app launch redirect (producer) and the host's
/// forwarded-request subdomain dispatch (consumer), so the URL a launch emits
/// and the host the dispatcher matches can't drift apart. Behind the
/// `subdomain-url` feature; pure string code, no extra deps.
#[cfg(feature = "subdomain-url")]
pub mod subdomain_host;
