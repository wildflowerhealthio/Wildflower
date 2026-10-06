//! The reachability monitor's [`HealthProbe`] over `reqwest`.
//!
//! [`ReqwestHealthProbe`] GETs `https://{public host}/health` and decodes the
//! server's `application/health+json` report (see
//! [`shared_structures_rust::health_check`]). The draft answers `200` for
//! `pass`/`warn` and `503` for `fail`, so both carry a report; any other
//! status, or a body that isn't a report, is an error.

use std::time::Duration;

use anyhow::Context;
use reqwest::StatusCode;
use shared_structures_rust::health_check::HealthReport;
use url::Url;

use crate::domain::reachability_monitor::HealthProbe;

/// A `reqwest`-backed `/health` probe. `rustls` TLS (no openssl), consistent
/// with the project's openssl avoidance.
pub(crate) struct ReqwestHealthProbe {
    client: reqwest::Client,
}

impl ReqwestHealthProbe {
    pub(crate) fn new() -> Self {
        let client = reqwest::Client::builder()
            // Pin rustls explicitly (the feature is enabled): the public relay
            // edge serves a normal CA cert, validated against the bundled roots.
            .use_rustls_tls()
            // A per-request timeout as a backstop; the monitor also bounds each
            // probe, so this only guards a client built without that wrapper.
            .timeout(Duration::from_secs(3))
            .build()
            // The TLS/connector build only fails on a broken TLS backend —
            // unrecoverable at startup, so surface it loudly.
            .expect("failed to build the /health probe HTTP client");
        Self { client }
    }
}

#[async_trait::async_trait]
impl HealthProbe for ReqwestHealthProbe {
    async fn probe(&self, health_url: &Url) -> anyhow::Result<HealthReport> {
        let response = self
            .client
            .get(health_url.clone())
            .send()
            .await
            .context("GET /health failed")?;
        let status = response.status();
        anyhow::ensure!(
            status == StatusCode::OK || status == StatusCode::SERVICE_UNAVAILABLE,
            "/health answered {status}"
        );
        response
            .json::<HealthReport>()
            .await
            .with_context(|| format!("/health answered {status} without a health report"))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Arc;

    use axum::http::{header, StatusCode};
    use axum::routing::get;
    use axum::Router;
    use shared_structures_rust::health_check::{
        health_router, ComponentType, HealthCheck, HealthCheckService, HealthStatus,
    };

    use super::*;

    /// A service with a fixed report.
    struct Fixed(HealthReport);

    #[async_trait::async_trait]
    impl HealthCheckService for Fixed {
        async fn check(&self) -> HealthReport {
            self.0.clone()
        }
    }

    fn report_with_server(status: HealthStatus) -> HealthReport {
        HealthReport::from_checks(BTreeMap::from([(
            "server".to_owned(),
            vec![HealthCheck {
                component_type: ComponentType::System,
                status,
                time: "2026-10-06T00:00:00Z".parse().expect("an RFC 3339 time"),
            }],
        )]))
    }

    /// Serve `router` on an ephemeral loopback port; returns its `/health` URL.
    async fn serve(router: Router) -> Url {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind an ephemeral port");
        let address = listener.local_addr().expect("local address");
        tokio::spawn(async move { axum::serve(listener, router).await });
        Url::parse(&format!("http://{address}/health")).expect("health URL")
    }

    #[tokio::test]
    async fn a_passing_server_s_report_decodes() {
        let report = report_with_server(HealthStatus::Pass);
        let health_url = serve(health_router(Arc::new(Fixed(report.clone())))).await;
        assert_eq!(
            ReqwestHealthProbe::new()
                .probe(&health_url)
                .await
                .expect("a report"),
            report
        );
    }

    /// A `503` still carries the report: the server answered, and said `fail`.
    #[tokio::test]
    async fn a_failing_server_s_503_report_decodes() {
        let report = report_with_server(HealthStatus::Fail);
        let health_url = serve(health_router(Arc::new(Fixed(report.clone())))).await;
        assert_eq!(
            ReqwestHealthProbe::new()
                .probe(&health_url)
                .await
                .expect("a report"),
            report
        );
    }

    #[tokio::test]
    async fn another_status_is_an_error() {
        let health_url = serve(Router::new().route(
            "/health",
            get(|| async { (StatusCode::BAD_GATEWAY, "relay has no tunnel") }),
        ))
        .await;
        let error = ReqwestHealthProbe::new()
            .probe(&health_url)
            .await
            .expect_err("a 502 is not a report");
        assert_eq!(format!("{error:#}"), "/health answered 502 Bad Gateway");
    }

    #[tokio::test]
    async fn a_200_without_a_report_is_an_error() {
        let health_url = serve(Router::new().route(
            "/health",
            get(|| async { ([(header::CONTENT_TYPE, "text/html")], "<html>hi</html>") }),
        ))
        .await;
        let error = ReqwestHealthProbe::new()
            .probe(&health_url)
            .await
            .expect_err("HTML is not a report");
        assert!(
            format!("{error:#}").starts_with("/health answered 200 OK without a health report"),
            "{error:#}"
        );
    }
}
