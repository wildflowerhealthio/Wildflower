//! The health-check service contract + a reusable `/health` router.
//!
//! A host (or, later, a slice) implements [`HealthCheckService`] to report its
//! status; [`health_router`] serves it at `GET /health` as a subset of the IETF
//! draft *Health Check Response Format for HTTP APIs*
//! (`draft-inadarei-api-health-check`): `application/health+json`, uncached,
//! `{ "status": "pass" | "warn" | "fail" }`. Other draft members (`checks`,
//! `serviceId`, `version`, …) are omitted until a consumer needs them.
//!
//! Behind the `health-check` cargo feature so the lean default build of
//! `shared-structures-rust` (and crates that don't serve `/health`) stays free
//! of `axum`/`async-trait`.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::Router;

/// Health status, per the draft: `pass` (healthy), `warn` (healthy but
/// degraded), `fail` (unhealthy).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthStatus {
    Pass,
    Warn,
    Fail,
}

impl HealthStatus {
    /// The draft wire spelling.
    fn as_wire(self) -> &'static str {
        match self {
            HealthStatus::Pass => "pass",
            HealthStatus::Warn => "warn",
            HealthStatus::Fail => "fail",
        }
    }

    /// The HTTP status the `/health` response carries: `pass`/`warn` are
    /// reachable-and-serving (200); `fail` is unhealthy (503).
    fn http_status(self) -> StatusCode {
        match self {
            HealthStatus::Pass | HealthStatus::Warn => StatusCode::OK,
            HealthStatus::Fail => StatusCode::SERVICE_UNAVAILABLE,
        }
    }
}

/// A health report — the subset of the draft body this serves. Just `status`
/// for now; richer members land when a consumer needs them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthReport {
    pub status: HealthStatus,
}

impl HealthReport {
    /// A healthy report.
    pub fn pass() -> Self {
        Self {
            status: HealthStatus::Pass,
        }
    }
}

/// Reports the current health of whatever it fronts. The host (or a slice)
/// implements it; [`health_router`] serves it. Object-safe so a host can hand
/// out `Arc<dyn HealthCheckService>`.
#[async_trait::async_trait]
pub trait HealthCheckService: Send + Sync {
    /// Produce the current health report.
    async fn check(&self) -> HealthReport;
}

/// A [`HealthCheckService`] that always reports `pass` — the trivial default
/// until a host wires real checks.
pub struct AlwaysHealthy;

#[async_trait::async_trait]
impl HealthCheckService for AlwaysHealthy {
    async fn check(&self) -> HealthReport {
        HealthReport::pass()
    }
}

/// The reusable `GET /health` router: serves `service`'s report as
/// `application/health+json`, uncached. `pass`/`warn` → 200, `fail` → 503.
/// Built by hand so the media type and `no-store` are exact (and so it needs no
/// `serde_json`).
pub fn health_router(service: Arc<dyn HealthCheckService>) -> Router {
    Router::new().route(
        "/health",
        get(move || {
            let service = Arc::clone(&service);
            async move { health_response(&service.check().await) }
        }),
    )
}

fn health_response(report: &HealthReport) -> Response {
    // `status` is a fixed `pass`/`warn`/`fail` literal — no JSON escaping needed.
    let body = format!(r#"{{"status":"{}"}}"#, report.status.as_wire());
    Response::builder()
        .status(report.status.http_status())
        .header(header::CONTENT_TYPE, "application/health+json")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(body))
        .expect("valid health response")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    /// A service with a fixed status — to drive the router across `pass`/`fail`.
    struct Fixed(HealthStatus);

    #[async_trait::async_trait]
    impl HealthCheckService for Fixed {
        async fn check(&self) -> HealthReport {
            HealthReport { status: self.0 }
        }
    }

    async fn get_health(
        service: Arc<dyn HealthCheckService>,
    ) -> (StatusCode, String, String, String) {
        let response = health_router(service)
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let content_type = header_value(&response, header::CONTENT_TYPE);
        let cache_control = header_value(&response, header::CACHE_CONTROL);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            content_type,
            cache_control,
            String::from_utf8(body.to_vec()).unwrap(),
        )
    }

    fn header_value(response: &Response, name: header::HeaderName) -> String {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string()
    }

    #[tokio::test]
    async fn always_healthy_serves_an_uncached_draft_pass() {
        let (status, content_type, cache_control, body) = get_health(Arc::new(AlwaysHealthy)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(content_type, "application/health+json");
        assert_eq!(cache_control, "no-store");
        assert_eq!(body, r#"{"status":"pass"}"#);
    }

    #[tokio::test]
    async fn a_failing_service_serves_503_fail() {
        let (status, _ct, _cc, body) = get_health(Arc::new(Fixed(HealthStatus::Fail))).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body, r#"{"status":"fail"}"#);
    }
}
