pub mod bridge;
pub mod owner_ui;
pub mod request_caller;
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

/// Reduce a base URL to its bare origin string — `scheme://host[:port]`, no
/// trailing slash (e.g. `http://127.0.0.1:8080`). The one place the
/// `url::Origin::ascii_serialization` reduction is spelled, so the callers that
/// stringify a loopback or per-request served base URL (loopback config origins,
/// forwarded served origins, discovery-doc issuer URLs) can't each render it a
/// slightly different way — the flap PR #224 warned about. Pure `url` code, so
/// it stays out of the axum-gated `served_origin` module and non-HTTP crates can
/// use it too. See `docs/Origins/Explanation.md`.
#[must_use]
pub fn origin_string(base_url: &url::Url) -> String {
    base_url.origin().ascii_serialization()
}

#[cfg(feature = "http-errors")]
pub mod http_errors;

#[cfg(feature = "openapi-snapshot")]
pub mod openapi_snapshot;

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

/// The diesel `JsonText` SQLite mapping (a `serde_json::Value` field stored in a
/// JSON TEXT column), shared by the diesel-backed slices. Behind the
/// `diesel-json-text` feature so only diesel-persisting `-rust` slices pull
/// `diesel`.
#[cfg(feature = "diesel-json-text")]
pub mod json_text;

#[cfg(test)]
mod tests {
    use super::origin_string;
    use url::Url;

    /// The bare origin drops the trailing slash and, per the URL Standard, the
    /// scheme's default port — the exact shape every consumer needs when it
    /// interpolates a served origin into a `Location` / discovery URL. Pinning it
    /// here is what lets the call sites stop each re-spelling the reduction.
    #[test]
    fn reduces_to_scheme_host_port_without_trailing_slash() {
        let loopback = Url::parse("http://127.0.0.1:8080/").expect("valid url");
        assert_eq!(origin_string(&loopback), "http://127.0.0.1:8080");

        // A non-default port is kept; the trailing path is dropped.
        let forwarded = Url::parse("https://emr.example.com:8443/token?x=1").expect("valid url");
        assert_eq!(origin_string(&forwarded), "https://emr.example.com:8443");

        // The scheme's default port (443 for https) is omitted from the origin.
        let default_port = Url::parse("https://example.com/path").expect("valid url");
        assert_eq!(origin_string(&default_port), "https://example.com");
    }
}
