//! The health-check service contract + a reusable `/health` router.
//!
//! A host (or a slice) implements [`HealthCheckService`] to report its status;
//! [`health_router`] serves it at `GET /health` in the IETF draft *Health Check
//! Response Format for HTTP APIs* (`draft-inadarei-api-health-check-06`):
//! `application/health+json`, uncached, with the draft's top-level `status`
//! and its `checks` object, keyed `"componentName[:measurementName]"`, each
//! key holding an array of check objects carrying `componentType`, `status`
//! and `time`. `pass` and `warn` answer `200`, `fail` answers `503`.
//!
//! The other draft members (`output`, `observedValue`, `observedUnit`,
//! `version`, `serviceId`, `notes`, `links`, …) are not served: `/health` is
//! public and unauthenticated, so the report says only whether each component
//! passes, is degraded or fails, never why or what runs it. Decoding ignores
//! them, as the draft lets a consumer do.
//!
//! Behind the `health-check` cargo feature so the lean default build of
//! `shared-structures-rust` (and crates that don't serve `/health`) stays free
//! of `axum`/`async-trait`/`serde_json`/`chrono`.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// The draft's media type for a health response.
pub const HEALTH_JSON_MEDIA_TYPE: &str = "application/health+json";

/// The path [`health_router`] serves the report at.
pub const HEALTH_PATH: &str = "/health";

/// Health status, per the draft: `pass` (healthy), `warn` (healthy but
/// degraded), `fail` (unhealthy). Ordered from best to worst, so the worst of
/// several is their [`Iterator::max`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthStatus {
    Pass,
    Warn,
    Fail,
}

impl HealthStatus {
    /// The HTTP status the `/health` response carries: `pass`/`warn` are
    /// reachable-and-serving (200); `fail` is unhealthy (503).
    #[must_use]
    pub fn http_status(self) -> StatusCode {
        match self {
            HealthStatus::Pass | HealthStatus::Warn => StatusCode::OK,
            HealthStatus::Fail => StatusCode::SERVICE_UNAVAILABLE,
        }
    }
}

/// What kind of component a check measures: the draft's pre-defined
/// `componentType` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ComponentType {
    /// A part of the service itself.
    Component,
    /// A store the service reads and writes.
    Datastore,
    /// The service as a whole, or the system it runs on.
    System,
}

/// One check object: the status one measurement of a component had at `time`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheck {
    pub component_type: ComponentType,
    pub status: HealthStatus,
    /// When the check ran, as an RFC 3339 date-time.
    pub time: DateTime<Utc>,
}

/// A health report: the draft body this serves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealthReport {
    /// The overall status: the worst of `checks`' statuses.
    pub status: HealthStatus,
    /// The checks behind `status`, keyed `"componentName[:measurementName]"`.
    /// Omitted from the body when empty.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub checks: BTreeMap<String, Vec<HealthCheck>>,
}

impl HealthReport {
    /// A healthy report with no checks.
    #[must_use]
    pub fn pass() -> Self {
        Self {
            status: HealthStatus::Pass,
            checks: BTreeMap::new(),
        }
    }

    /// The report over `checks`, whose status is the worst of theirs (`pass`
    /// when there are none).
    #[must_use]
    pub fn from_checks(checks: BTreeMap<String, Vec<HealthCheck>>) -> Self {
        let status = checks
            .values()
            .flatten()
            .map(|check| check.status)
            .max()
            .unwrap_or(HealthStatus::Pass);
        Self { status, checks }
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

/// A [`HealthCheckService`] that always reports `pass`, with no checks: for a
/// service that is healthy whenever it can answer.
pub struct AlwaysHealthy;

#[async_trait::async_trait]
impl HealthCheckService for AlwaysHealthy {
    async fn check(&self) -> HealthReport {
        HealthReport::pass()
    }
}

/// The reusable `GET /health` router: serves `service`'s report as
/// `application/health+json`, uncached. `pass`/`warn` → 200, `fail` → 503.
pub fn health_router(service: Arc<dyn HealthCheckService>) -> Router {
    Router::new().route(
        HEALTH_PATH,
        get(move || {
            let service = Arc::clone(&service);
            async move { health_response(&service.check().await) }
        }),
    )
}

fn health_response(report: &HealthReport) -> Response {
    let body = serde_json::to_vec(report).expect("a health report serializes");
    Response::builder()
        .status(report.status.http_status())
        .header(header::CONTENT_TYPE, HEALTH_JSON_MEDIA_TYPE)
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

    /// A service with a fixed report — to drive the router across statuses.
    struct Fixed(HealthReport);

    #[async_trait::async_trait]
    impl HealthCheckService for Fixed {
        async fn check(&self) -> HealthReport {
            self.0.clone()
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

    fn check_at_midnight(component_type: ComponentType, status: HealthStatus) -> HealthCheck {
        HealthCheck {
            component_type,
            status,
            time: "2026-10-06T00:00:00Z".parse().expect("an RFC 3339 time"),
        }
    }

    fn report_of(fhir_r4: HealthStatus, server: HealthStatus) -> HealthReport {
        HealthReport::from_checks(BTreeMap::from([
            (
                "fhir-r4".to_owned(),
                vec![check_at_midnight(ComponentType::Component, fhir_r4)],
            ),
            (
                "server".to_owned(),
                vec![check_at_midnight(ComponentType::System, server)],
            ),
        ]))
    }

    #[tokio::test]
    async fn always_healthy_serves_an_uncached_draft_pass() {
        let (status, content_type, cache_control, body) = get_health(Arc::new(AlwaysHealthy)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(content_type, "application/health+json");
        assert_eq!(cache_control, "no-store");
        assert_eq!(body, r#"{"status":"pass"}"#);
    }

    /// The body is exactly the draft's `status` and `checks`, each check
    /// object its `componentType`, `status` and `time`: no output, observed
    /// value or version.
    #[tokio::test]
    async fn a_report_with_checks_serves_the_draft_shape() {
        let (status, content_type, cache_control, body) = get_health(Arc::new(Fixed(report_of(
            HealthStatus::Pass,
            HealthStatus::Warn,
        ))))
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(content_type, "application/health+json");
        assert_eq!(cache_control, "no-store");
        assert_eq!(
            body,
            concat!(
                r#"{"status":"warn","checks":{"#,
                r#""fhir-r4":[{"componentType":"component","status":"pass","time":"2026-10-06T00:00:00Z"}],"#,
                r#""server":[{"componentType":"system","status":"warn","time":"2026-10-06T00:00:00Z"}]"#,
                r#"}}"#
            )
        );
    }

    #[tokio::test]
    async fn a_failing_check_serves_503_fail() {
        let (status, _content_type, _cache_control, body) = get_health(Arc::new(Fixed(report_of(
            HealthStatus::Fail,
            HealthStatus::Pass,
        ))))
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            body,
            concat!(
                r#"{"status":"fail","checks":{"#,
                r#""fhir-r4":[{"componentType":"component","status":"fail","time":"2026-10-06T00:00:00Z"}],"#,
                r#""server":[{"componentType":"system","status":"pass","time":"2026-10-06T00:00:00Z"}]"#,
                r#"}}"#
            )
        );
    }

    #[test]
    fn the_overall_status_is_the_worst_check() {
        for (fhir_r4, server, overall) in [
            (HealthStatus::Pass, HealthStatus::Pass, HealthStatus::Pass),
            (HealthStatus::Warn, HealthStatus::Pass, HealthStatus::Warn),
            (HealthStatus::Pass, HealthStatus::Fail, HealthStatus::Fail),
            (HealthStatus::Fail, HealthStatus::Warn, HealthStatus::Fail),
        ] {
            assert_eq!(report_of(fhir_r4, server).status, overall);
        }
        assert_eq!(
            HealthReport::from_checks(BTreeMap::new()),
            HealthReport::pass()
        );
    }

    /// The served body decodes back to the report it came from.
    #[tokio::test]
    async fn a_served_report_decodes_to_itself() {
        let report = report_of(HealthStatus::Warn, HealthStatus::Fail);
        let (_status, _content_type, _cache_control, body) =
            get_health(Arc::new(Fixed(report.clone()))).await;
        assert_eq!(
            serde_json::from_str::<HealthReport>(&body).expect("a health report"),
            report
        );
    }

    /// A consumer decodes a report from another draft producer, ignoring the
    /// members this one never serves.
    #[test]
    fn decoding_ignores_members_it_does_not_serve() {
        let report: HealthReport = serde_json::from_str(
            r#"{"status":"pass","version":"1","checks":{"db:responseTime":[
                {"componentType":"datastore","status":"pass","time":"2026-10-06T00:00:00Z",
                 "observedValue":3,"observedUnit":"ms","output":""}]}}"#,
        )
        .expect("a draft report decodes");
        assert_eq!(
            report,
            HealthReport::from_checks(BTreeMap::from([(
                "db:responseTime".to_owned(),
                vec![check_at_midnight(
                    ComponentType::Datastore,
                    HealthStatus::Pass
                )],
            )]))
        );
    }
}
