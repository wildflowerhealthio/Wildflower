//! Host adapters that plug the tunnel slice's ports into real implementations:
//!
//!  - [`ReqwestHealthProbe`] implements `tunnel_rust::HealthProbe` — the daemon
//!    uses it to GET `https://{publicHost}/health` and confirm the tunnel
//!    reaches a live server. The served origin is assumed to expose an
//!    RFC-compliant `/health` (`draft-inadarei-api-health-check`): a 2xx with
//!    `status: "pass"` is healthy; the probe doesn't check identity. The TLS
//!    HTTP client lives here (in the host) rather than in the slice; positioned
//!    to later health-check every slice.
//!  - [`TunnelLaunchAdapter`] implements `apps_rust::TunnelLaunchResolver` — the
//!    apps launch handler resolves a `requires_tunnel` launch through it, which
//!    turns the tunnel on and returns its verified public origin (or `None` on
//!    failure, so the launch falls back to loopback + `?tunnel=unavailable`).

use std::time::Duration;

use serde::Deserialize;
use tunnel_rust::{HealthProbe, TunnelControl};

/// The one field of the RFC health body the probe reads: `status` is
/// `pass`/`warn`/`fail`; only `pass` counts as healthy. Other members
/// (`version`, `checks`, …) are ignored.
#[derive(Deserialize)]
struct HealthBody {
    status: String,
}

/// A `reqwest`-backed `/health` probe. `rustls` TLS (no openssl), consistent
/// with the project's openssl avoidance.
pub struct ReqwestHealthProbe {
    client: reqwest::Client,
}

impl ReqwestHealthProbe {
    pub fn new() -> Self {
        // A per-request timeout as a backstop; the daemon also bounds each probe
        // (see `control`/`tunnel_daemon`'s probe timeout), so this only guards
        // against a client built without that wrapper.
        let client = reqwest::Client::builder()
            // Pin rustls explicitly (the feature is enabled): the public relay
            // edge serves a normal CA cert, validated against the bundled roots.
            .use_rustls_tls()
            .timeout(Duration::from_secs(3))
            .build()
            // The TLS/connector build only fails on a broken TLS backend —
            // unrecoverable at startup, so surface it loudly.
            .expect("failed to build the tunnel health-probe HTTP client");
        Self { client }
    }
}

impl Default for ReqwestHealthProbe {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl HealthProbe for ReqwestHealthProbe {
    async fn probe(&self, url: &str) -> Result<(), String> {
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("non-success status {status}"));
        }
        let body = response
            .json::<HealthBody>()
            .await
            .map_err(|e| format!("malformed /health body: {e}"))?;
        if body.status == "pass" {
            Ok(())
        } else {
            Err(format!("/health reported status {:?}", body.status))
        }
    }
}

/// Resolves a `requires_tunnel` launch by driving the tunnel control seam: turn
/// the tunnel on and return its verified public origin, or `None` if it can't be
/// brought up within the control's verify deadline.
pub struct TunnelLaunchAdapter {
    control: TunnelControl,
}

impl TunnelLaunchAdapter {
    pub fn new(control: TunnelControl) -> Self {
        Self { control }
    }
}

#[async_trait::async_trait]
impl apps_rust::TunnelLaunchResolver for TunnelLaunchAdapter {
    async fn resolve_tunnel_origin(&self) -> Option<String> {
        // `Err` (relay unconfigured, no public host, never verified) → fall back
        // to loopback + `?tunnel=unavailable`; the reason is already logged by
        // the control seam's callers.
        self.control.request_start().await.ok()
    }
}
