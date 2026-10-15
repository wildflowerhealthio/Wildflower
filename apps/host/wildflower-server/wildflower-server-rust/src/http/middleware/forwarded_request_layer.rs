//! The forwarded-request report, on the tunnel listener's router: after each
//! forwarded request (every request through the tunnel) report what it was and
//! who made it to the host and to the request-log slice; a `/health` check goes
//! to the request log only.
//!
//! The caller is read off the response's [`RequestCaller`] extension, and a
//! bearer gate's `401` off its [`RequestRefusal`] one; the authorization server bearer
//! gates stamp both (see `wildflowerhealthio_shared_structures::request_caller`). The host
//! turns the reports into "this app is using your server" notifications.

mod reduced_path;

use std::time::{Instant, SystemTime};

use axum::body::HttpBody;
use axum::extract::{ConnectInfo, Request, State};
use axum::middleware::Next;
use axum::response::Response;
use tokio::sync::mpsc;
use wildflowerhealthio_shared_structures::health_check::HEALTH_PATH;
use wildflowerhealthio_shared_structures::request_caller::{
    ForwardedRequest, RequestCaller, RequestRefusal,
};

use crate::http::tunnel_listener::TunnelVisitor;

use reduced_path::reduced_path;

/// What [`report_forwarded_request`] reports with: the host every record names
/// as served, and the two channels each record goes to: the host's, which
/// turns them into notifications, and the request-log slice's writer.
#[derive(Clone)]
pub(crate) struct ForwardedRequestReporter {
    /// The server's public `host[:port]`, from its origin.
    pub(crate) served_host: String,
    /// The host's channel (`ServerObservers::forwarded_request_tx`).
    pub(crate) host_tx: mpsc::Sender<ForwardedRequest>,
    /// The request-log writer's channel
    /// (`wildflowerhealthio_request_log::RequestLog::forwarded_request_tx`).
    pub(crate) request_log_tx: mpsc::Sender<ForwardedRequest>,
}

/// Report a [`ForwardedRequest`] through `forwarded_request_reporter` once the
/// response to a tunnel request is ready, naming the visitor its
/// [`TunnelVisitor`] connect info holds. A `GET /health` ([`HEALTH_PATH`]) goes
/// to the request log but not the host: the reachability monitor asks it
/// through the relay at the start of every run, and a health check is nobody
/// using the server.
///
/// # Remarks
///
/// Each report uses `try_send`, and a full channel drops it with a debug log.
/// This is the one place a dropped value is the right outcome: the report is an
/// observation feeding a best-effort notification count and log, and the
/// alternative, awaiting room in a channel, would hold a patient's FHIR response
/// hostage to how fast the host drains notifications or the log writes. A
/// closed channel (its reader stopped listening) is dropped the same way, since
/// there is nobody left to tell.
pub(crate) async fn report_forwarded_request(
    State(forwarded_request_reporter): State<ForwardedRequestReporter>,
    ConnectInfo(tunnel_visitor): ConnectInfo<TunnelVisitor>,
    request: Request,
    next: Next,
) -> Response {
    let is_health_check = request.uri().path() == HEALTH_PATH;
    let received_at = SystemTime::now();
    let started = Instant::now();
    let client_address = tunnel_visitor
        .client_address
        .map(|client_address| client_address.ip().to_string());
    let method = request.method().to_string();
    let reduced_path = reduced_path(request.uri());

    let response = next.run(request).await;

    let forwarded_request = ForwardedRequest {
        received_at,
        client_address,
        served_host: Some(forwarded_request_reporter.served_host.clone()),
        method,
        reduced_path,
        status: response.status().as_u16(),
        response_bytes: response.body().size_hint().exact(),
        duration: started.elapsed(),
        caller: response.extensions().get::<RequestCaller>().cloned(),
        refusal: response.extensions().get::<RequestRefusal>().copied(),
    };
    if !is_health_check {
        if let Err(error) = forwarded_request_reporter
            .host_tx
            .try_send(forwarded_request.clone())
        {
            tracing::debug!("forwarded-request report to the host dropped: {error}");
        }
    }
    if let Err(error) = forwarded_request_reporter
        .request_log_tx
        .try_send(forwarded_request)
    {
        tracing::debug!("forwarded-request report to the request log dropped: {error}");
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::StatusCode;
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt;

    fn lifting() -> RequestCaller {
        RequestCaller {
            client_id: "lifting".to_owned(),
        }
    }

    /// A response stamped the way a bearer gate stamps one: `status`, with the
    /// verified `caller` or the gate's `refusal`.
    fn stamped(
        status: StatusCode,
        caller: Option<RequestCaller>,
        refusal: Option<RequestRefusal>,
    ) -> Response {
        let mut response = Response::new(Body::from("body"));
        *response.status_mut() = status;
        if let Some(caller) = caller {
            response.extensions_mut().insert(caller);
        }
        if let Some(refusal) = refusal {
            response.extensions_mut().insert(refusal);
        }
        response
    }

    /// A router wrapped in the layer, whose routes answer the way the gated
    /// slices do: `/Patient/{id}` a `200` to the `lifting` client,
    /// `/authorization/grants` a scope `403` to it, `/refused/{refusal}` each bearer
    /// gate `401`, and `/anonymous` an ungated `200`.
    fn reporting_router(forwarded_request_reporter: ForwardedRequestReporter) -> Router {
        Router::new()
            .route(
                "/Patient/{id}",
                get(|| async { stamped(StatusCode::OK, Some(lifting()), None) }),
            )
            .route(
                "/authorization/grants",
                get(|| async { stamped(StatusCode::FORBIDDEN, Some(lifting()), None) }),
            )
            .route(
                "/refused/missing",
                get(|| async {
                    stamped(
                        StatusCode::UNAUTHORIZED,
                        None,
                        Some(RequestRefusal::MissingToken),
                    )
                }),
            )
            .route(
                "/refused/rejected",
                get(|| async {
                    stamped(
                        StatusCode::UNAUTHORIZED,
                        None,
                        Some(RequestRefusal::TokenRejected),
                    )
                }),
            )
            .route(
                "/refused/revoked",
                get(|| async {
                    stamped(
                        StatusCode::UNAUTHORIZED,
                        None,
                        Some(RequestRefusal::Revoked),
                    )
                }),
            )
            .route("/anonymous", get(|| async { "anonymous" }))
            .route(HEALTH_PATH, get(|| async { "pass" }))
            .layer(axum::middleware::from_fn_with_state(
                forwarded_request_reporter,
                report_forwarded_request,
            ))
    }

    /// A tunnel request for `path` from the visitor at `client_address`, with
    /// `headers`.
    fn tunnel_get_from(
        path: &str,
        client_address: Option<&str>,
        headers: &[(&str, &str)],
    ) -> Request {
        let mut builder = Request::get(path);
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        let mut request = builder.body(Body::empty()).expect("request");
        request.extensions_mut().insert(ConnectInfo(TunnelVisitor {
            client_address: client_address.map(|address| address.parse().expect("address")),
        }));
        request
    }

    /// A tunnel request for `path` from the visitor at `192.0.2.1:4711`.
    fn tunnel_get(path: &str) -> Request {
        tunnel_get_from(path, Some("192.0.2.1:4711"), &[])
    }

    /// The layer's reporter, for the server at `demo.example.com`, over
    /// channels of `capacity`, and the host's and the request log's receivers.
    fn reporter(
        capacity: usize,
    ) -> (
        ForwardedRequestReporter,
        mpsc::Receiver<ForwardedRequest>,
        mpsc::Receiver<ForwardedRequest>,
    ) {
        let (host_tx, host_rx) = mpsc::channel(capacity);
        let (request_log_tx, request_log_rx) = mpsc::channel(capacity);
        (
            ForwardedRequestReporter {
                served_host: "demo.example.com".to_owned(),
                host_tx,
                request_log_tx,
            },
            host_rx,
            request_log_rx,
        )
    }

    /// The one record `receiver` got, checking its sender is gone with nothing
    /// more queued.
    fn only_record(receiver: &mut mpsc::Receiver<ForwardedRequest>) -> ForwardedRequest {
        let forwarded_request = receiver.try_recv().expect("one record reported");
        assert_eq!(
            receiver.try_recv(),
            Err(mpsc::error::TryRecvError::Disconnected),
            "exactly one record per request"
        );
        forwarded_request
    }

    /// Send `request` through the layer and return the one record it reported,
    /// which the host and the request log both got.
    async fn reported(request: Request) -> ForwardedRequest {
        let (reporter, mut host_rx, mut request_log_rx) = reporter(4);
        reporting_router(reporter)
            .oneshot(request)
            .await
            .expect("oneshot");
        let forwarded_request = only_record(&mut host_rx);
        assert_eq!(only_record(&mut request_log_rx), forwarded_request);
        forwarded_request
    }

    #[tokio::test]
    async fn a_forwarded_request_reports_its_record() {
        let before = SystemTime::now();
        let forwarded_request = reported(tunnel_get("/Patient/123?_format=json")).await;

        assert!(forwarded_request.received_at >= before);
        assert!(forwarded_request.received_at <= SystemTime::now());
        assert_eq!(
            forwarded_request,
            ForwardedRequest {
                client_address: Some("192.0.2.1".to_owned()),
                served_host: Some("demo.example.com".to_owned()),
                method: "GET".to_owned(),
                reduced_path: "/Patient".to_owned(),
                status: 200,
                response_bytes: Some(4),
                caller: Some(lifting()),
                refusal: None,
                ..forwarded_request.clone()
            }
        );
    }

    #[tokio::test]
    async fn a_scope_failure_reports_the_caller_and_the_403() {
        let forwarded_request = reported(tunnel_get("/authorization/grants")).await;

        assert_eq!(forwarded_request.status, 403);
        assert_eq!(forwarded_request.caller, Some(lifting()));
        assert_eq!(forwarded_request.refusal, None);
        assert_eq!(forwarded_request.reduced_path, "/authorization");
    }

    #[tokio::test]
    async fn each_401_reports_its_refusal_and_no_caller() {
        for (path, refusal) in [
            ("/refused/missing", RequestRefusal::MissingToken),
            ("/refused/rejected", RequestRefusal::TokenRejected),
            ("/refused/revoked", RequestRefusal::Revoked),
        ] {
            let forwarded_request = reported(tunnel_get(path)).await;
            assert_eq!(forwarded_request.status, 401, "{path}");
            assert_eq!(forwarded_request.refusal, Some(refusal), "{path}");
            assert_eq!(forwarded_request.caller, None, "{path}");
        }
    }

    #[tokio::test]
    async fn a_forwarded_request_with_no_caller_reports_none() {
        let forwarded_request = reported(tunnel_get("/anonymous")).await;

        assert_eq!(forwarded_request.caller, None);
        assert_eq!(forwarded_request.refusal, None);
    }

    /// The visitor's address is its [`TunnelVisitor`]'s IP, without the port,
    /// and absent when the connection named none.
    #[tokio::test]
    async fn the_visitor_address_comes_from_the_tunnel_visitor() {
        for (client_address, recorded) in [
            (Some("192.0.2.1:4711"), Some("192.0.2.1")),
            (Some("[2001:db8::1]:4711"), Some("2001:db8::1")),
            (None, None),
        ] {
            let forwarded_request =
                reported(tunnel_get_from("/anonymous", client_address, &[])).await;
            assert_eq!(
                forwarded_request.client_address.as_deref(),
                recorded,
                "{client_address:?}"
            );
        }
    }

    /// A request is reported as served at the server's host, and from its
    /// tunnel visitor, whatever `Forwarded` or `Host` it carries.
    #[tokio::test]
    async fn a_request_s_own_headers_name_neither_host_nor_visitor() {
        let forwarded_request = reported(tunnel_get_from(
            "/anonymous",
            Some("192.0.2.1:4711"),
            &[
                ("host", "evil.example.com"),
                (
                    "forwarded",
                    "for=203.0.113.9;host=evil.example.com;proto=http",
                ),
            ],
        ))
        .await;
        assert_eq!(
            (
                forwarded_request.served_host.as_deref(),
                forwarded_request.client_address.as_deref()
            ),
            (Some("demo.example.com"), Some("192.0.2.1"))
        );
    }

    /// A `/health` check is in the request log but not the host's
    /// notifications, and is still answered.
    #[tokio::test]
    async fn a_forwarded_health_check_is_logged_but_not_notified() {
        let (reporter, mut host_rx, mut request_log_rx) = reporter(4);
        let router = reporting_router(reporter);
        let response = router
            .clone()
            .oneshot(tunnel_get(HEALTH_PATH))
            .await
            .expect("oneshot");
        assert_eq!(response.status(), StatusCode::OK);

        assert_eq!(
            host_rx.try_recv(),
            Err(mpsc::error::TryRecvError::Empty),
            "a forwarded /health must not notify the host"
        );
        let logged = request_log_rx.try_recv().expect("logged");
        assert_eq!(logged.reduced_path, HEALTH_PATH);
    }

    /// A host or log writer that falls behind never slows the API: with the
    /// channels full the request is still answered, and the report is dropped.
    #[tokio::test]
    async fn a_full_channel_drops_the_report_and_still_answers() {
        let (reporter, mut receiver, _request_log_rx) = reporter(1);
        let router = reporting_router(reporter);
        for _ in 0..2 {
            let response = router
                .clone()
                .oneshot(tunnel_get("/anonymous"))
                .await
                .expect("oneshot");
            assert_eq!(response.status(), StatusCode::OK);
        }

        assert!(receiver.try_recv().is_ok());
        assert_eq!(
            receiver.try_recv(),
            Err(mpsc::error::TryRecvError::Empty),
            "the second report overflowed the one-slot channel"
        );
    }
}
