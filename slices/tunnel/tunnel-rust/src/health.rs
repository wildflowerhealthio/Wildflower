//! The tunnel liveness contract — a real "is the tunnel actually carrying
//! traffic to *this* device" signal, replacing the optimistic `running` /
//! `servedOrigin` for the start path (tracked in
//! <https://github.com/Assessment-is/Wildflower/issues/184>).
//!
//! The wire shape is a subset of the IETF draft
//! [*Health Check Response Format for HTTP APIs*][rfc]
//! (`draft-inadarei-api-health-check-06`): a `200` with media type
//! `application/health+json` and a body whose `status` is one of
//! `pass`/`warn`/`fail` (we only ever emit `pass`) alongside the draft's
//! optional `serviceId`. We deliberately implement just that subset; the other
//! draft members (`version`, `checks`, `output`, …) are omitted until a
//! consumer needs them.
//!
//! Two halves, wired in different layers:
//!
//!  - the **`/health` endpoint** ([`health_router`]) — an unauthenticated,
//!    uncached `GET /health` that always answers `200 { "status": "pass",
//!    "serviceId": … }`. It rides the same loopback server the relay forwards
//!    to, so a request to `https://{publicHost}/health` round-trips through the
//!    tunnel back to this process. Mounted *outside* the gatekeeper gate by the
//!    host so the probe needs no bearer token.
//!  - the **[`HealthProbe`] port** — the start path GETs `{origin}/health` and
//!    only resolves `Ok(origin)` when the body is `pass` *and* the echoed
//!    `serviceId` matches this process's. The concrete (networked) adapter lives
//!    in the host (`wildflower-tauri`), so the TLS HTTP client stays out of the
//!    slice and the same prober can later health-check every slice.
//!
//! The [`serviceId`](HealthCheck::service_id) is a random per-process nonce — a
//! gentle guarantee the probe looped back to this device rather than resolving
//! to some other host (a captive portal, a stale relay route). It is not a
//! secret and is not stable across restarts.
//!
//! [rfc]: https://datatracker.ietf.org/doc/html/draft-inadarei-api-health-check-06

use axum::body::Body;
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use rand::Rng;
use serde::{Deserialize, Serialize};

/// The `status` for a healthy server. The draft defines `pass`/`warn`/`fail`;
/// this service only ever reports `pass` (it has nothing to degrade to), and a
/// consumer treats any other value — or a non-2xx — as "not healthy".
pub const HEALTH_STATUS_PASS: &str = "pass";

/// The draft media type for a health response body
/// (`draft-inadarei-api-health-check-06`, §3).
const HEALTH_CONTENT_TYPE: &str = "application/health+json";

/// The `/health` body — `{ "status": "pass", "serviceId": "<nonce>" }`. The
/// subset of the draft health-check shape we implement. Shared by the endpoint
/// (which serializes it) and the [`HealthProbe`] adapter (which deserializes
/// it), so the two can't drift.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheck {
    /// `pass`/`warn`/`fail` per the draft; this service only emits
    /// [`HEALTH_STATUS_PASS`].
    pub status: String,
    /// The draft's optional `serviceId`. Here it's the serving process's
    /// per-run nonce — the probe matches it against the expected id to confirm
    /// the request reached *this* device.
    pub service_id: String,
}

/// Fetches a `/health` URL and parses the body. The networked adapter lives in
/// the host; the slice depends only on this port so its tests inject a fake.
///
/// Implementations report a 2xx body as `Ok(HealthCheck)` and anything else
/// (non-2xx, transport error, malformed body) as `Err(reason)`. They need not
/// impose an overall deadline — the caller bounds every probe with
/// `control::PROBE_TIMEOUT`, so the timeout guarantee holds regardless of the
/// adapter.
#[async_trait::async_trait]
pub trait HealthProbe: Send + Sync {
    /// `GET url`, returning the parsed [`HealthCheck`] on success or a
    /// human-readable failure otherwise.
    async fn probe(&self, url: &str) -> Result<HealthCheck, String>;
}

/// A random per-process service id. Not a secret and not stable across
/// restarts — purely the self-loop guard the probe matches on (see the module
/// docs).
pub(crate) fn generate_service_id() -> String {
    let mut bytes = [0u8; 16];
    rand::rng().fill(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The unauthenticated, uncached `GET /health` router. The host merges this
/// *outside* the gatekeeper gate so the external probe (and any uptime check)
/// reaches it without a bearer token.
///
/// The response is built by hand rather than via `Json` so it carries the
/// draft's `application/health+json` media type (not `application/json`) and
/// `Cache-Control: no-store` — the latter keeps an intermediary from serving a
/// stale `pass` after the device-edge has gone.
pub(crate) fn health_router(service_id: String) -> Router {
    let body = HealthCheck {
        status: HEALTH_STATUS_PASS.to_string(),
        service_id,
    };
    Router::new().route(
        "/health",
        get(move || {
            let body = body.clone();
            async move { health_response(&body) }
        }),
    )
}

/// Render a [`HealthCheck`] as the draft-shaped `200 application/health+json`,
/// uncached response.
fn health_response(body: &HealthCheck) -> Response {
    // `serde_json::to_vec` on a two-`String` struct is infallible.
    let json = serde_json::to_vec(body).expect("HealthCheck serializes");
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, HEALTH_CONTENT_TYPE)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(json))
        .expect("valid health response")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    /// The route answers `200`, the draft `application/health+json` media type,
    /// `no-store`, and a `pass` body echoing the id it was built with — the
    /// exact contract the probe matches against.
    #[tokio::test]
    async fn health_route_returns_uncached_draft_pass_with_the_service_id() {
        let app = health_router("svc-123".to_string());
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some(HEALTH_CONTENT_TYPE),
        );
        assert_eq!(
            response
                .headers()
                .get(header::CACHE_CONTROL)
                .and_then(|v| v.to_str().ok()),
            Some("no-store"),
        );
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let parsed: HealthCheck = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            parsed,
            HealthCheck {
                status: HEALTH_STATUS_PASS.to_string(),
                service_id: "svc-123".to_string(),
            },
        );
    }

    /// `serviceId` is camelCase on the wire (matching the draft's member name)
    /// so the host adapter and any JS uptime check read the same key.
    #[test]
    fn health_check_serializes_service_id_as_camel_case() {
        let json = serde_json::to_string(&HealthCheck {
            status: HEALTH_STATUS_PASS.to_string(),
            service_id: "abc".to_string(),
        })
        .unwrap();
        assert_eq!(json, r#"{"status":"pass","serviceId":"abc"}"#);
    }

    /// The id is a 128-bit nonce rendered as 32 lowercase hex chars, and two
    /// generations don't collide — enough to make a cross-host loop detectable.
    #[test]
    fn generated_service_ids_are_distinct_hex_nonces() {
        let a = generate_service_id();
        let b = generate_service_id();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
