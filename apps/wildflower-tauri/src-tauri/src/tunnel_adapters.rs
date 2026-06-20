//! Host adapter for the tunnel's reachability probe.
//!
//! [`ReqwestHealthProbe`] implements `tunnel_rust::HealthProbe` — the daemon
//! uses it to GET `https://{publicHost}/health` and confirm the tunnel reaches a
//! live server. The served origin's `/health` is defined at the app layer (see
//! [`crate::health_router`]); for now any 2xx counts as healthy, with
//! RFC-detail checks deferred. The TLS HTTP client lives here (in the host)
//! rather than in the slice; positioned to later health-check every slice.
//!
//! The *outbound* side — the tunnel service the apps slice consumes — needs no
//! adapter here: `tunnel_rust::TunnelControl` implements
//! `shared_structures_rust::tunnel_service::TunnelService` directly, so the
//! composition root hands `tunnel.control` straight to `setup_apps`.

use std::time::Duration;

use tunnel_rust::HealthProbe;

/// A `reqwest`-backed `/health` probe. `rustls` TLS (no openssl), consistent
/// with the project's openssl avoidance.
pub struct ReqwestHealthProbe {
    client: reqwest::Client,
}

impl ReqwestHealthProbe {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            // Pin rustls explicitly (the feature is enabled): the public relay
            // edge serves a normal CA cert, validated against the bundled roots.
            .use_rustls_tls()
            // A per-request timeout as a backstop; the daemon also bounds each
            // probe, so this only guards a client built without that wrapper.
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
        // Any 2xx is healthy for now; RFC-detail checks (the `status` member,
        // per-slice checks) land later.
        if status.is_success() {
            Ok(())
        } else {
            Err(format!("non-success status {status}"))
        }
    }
}
