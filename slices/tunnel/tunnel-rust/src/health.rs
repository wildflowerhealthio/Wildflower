//! The tunnel reachability port: a real "is the tunnel actually carrying
//! traffic" signal, replacing the optimistic `running` / `servedOrigin` for the
//! start path (closes
//! <https://github.com/Assessment-is/Wildflower/issues/184>).
//!
//! The daemon's supervisor probes an **assumed-present, RFC-compliant**
//! `/health` on the served origin (the IETF draft *Health Check Response Format
//! for HTTP APIs*, `draft-inadarei-api-health-check-06`: a `200`
//! `application/health+json` with `status: "pass"`). Any healthy response is
//! enough — the tunnel only needs to know the round-trip reaches a live server;
//! it does not serve `/health` itself, nor does it check identity.
//!
//! The networked adapter ([`HealthProbe`] implementation) lives in the host
//! (`wildflower-tauri`), so the TLS HTTP client stays out of the slice and the
//! same prober can later reach any slice's `/health`.

/// Probes a `/health` URL and reports whether it answered healthy.
///
/// `Ok(())` means the endpoint responded healthy (a 2xx RFC health response);
/// `Err(reason)` means unreachable, non-2xx, or not-healthy. The daemon turns
/// `Ok` into `Verified` and `Err` into `Unreachable`. Implementations need not
/// impose an overall deadline — the daemon bounds every probe (see the probe
/// timeout in `tunnel_daemon`), so the timeout guarantee holds regardless of the
/// adapter.
#[async_trait::async_trait]
pub trait HealthProbe: Send + Sync {
    /// `GET url` and return `Ok(())` iff it answered healthy.
    async fn probe(&self, url: &str) -> Result<(), String>;
}
