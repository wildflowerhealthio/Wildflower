//! The forwarded-request report, on the tunnel listener's router: after each
//! forwarded request (every request through the tunnel) report what it was and
//! who made it to the request-log slice.
//!
//! The caller is read off the response's [`RequestCaller`] extension, and a
//! bearer gate's `401` off its [`RequestRefusal`] one; the authorization server bearer
//! gates stamp both (see `wildflowerhealthio_shared_structures::request_caller`).

mod reduced_path;

use std::time::{Instant, SystemTime};

use axum::body::HttpBody;
use axum::extract::{ConnectInfo, Request, State};
use axum::middleware::Next;
use axum::response::Response;
use tokio::sync::mpsc;
use wildflowerhealthio_shared_structures::request_caller::{
    ForwardedRequest, RequestCaller, RequestRefusal,
};

use crate::http::tunnel_listener::TunnelVisitor;

use reduced_path::reduced_path;

/// Report a [`ForwardedRequest`] on `request_log_tx`, the request-log
/// writer's channel (`wildflowerhealthio_request_log::RequestLog::forwarded_request_tx`),
/// once the response to a tunnel request is ready, naming the visitor its
/// [`TunnelVisitor`] connect info holds.
///
/// # Remarks
///
/// The report uses `try_send`, and a full channel drops it with a debug log.
/// This is the one place a dropped value is the right outcome: the report is an
/// observation feeding a best-effort log, and the alternative, awaiting room in
/// a channel, would hold a patient's FHIR response hostage to how fast the log
/// writes. A closed channel (its reader stopped listening) is dropped the same
/// way, since there is nobody left to tell.
pub(crate) async fn report_forwarded_request(
    State(request_log_tx): State<mpsc::Sender<ForwardedRequest>>,
    ConnectInfo(tunnel_visitor): ConnectInfo<TunnelVisitor>,
    request: Request,
    next: Next,
) -> Response {
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
        method,
        reduced_path,
        status: response.status().as_u16(),
        response_bytes: response.body().size_hint().exact(),
        duration: started.elapsed(),
        caller: response.extensions().get::<RequestCaller>().cloned(),
        refusal: response.extensions().get::<RequestRefusal>().copied(),
    };
    if let Err(error) = request_log_tx.try_send(forwarded_request) {
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
    fn reporting_router(request_log_tx: mpsc::Sender<ForwardedRequest>) -> Router {
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
            .layer(axum::middleware::from_fn_with_state(
                request_log_tx,
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

    /// Send `request` through the layer and return the one record it reported.
    async fn reported(request: Request) -> ForwardedRequest {
        let (request_log_tx, mut request_log_rx) = mpsc::channel(4);
        reporting_router(request_log_tx)
            .oneshot(request)
            .await
            .expect("oneshot");
        only_record(&mut request_log_rx)
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

    /// A request is reported from its tunnel visitor, whatever `Forwarded` it
    /// carries.
    #[tokio::test]
    async fn a_request_s_own_headers_name_no_visitor() {
        let forwarded_request = reported(tunnel_get_from(
            "/anonymous",
            Some("192.0.2.1:4711"),
            &[(
                "forwarded",
                "for=203.0.113.9;host=evil.example.com;proto=http",
            )],
        ))
        .await;
        assert_eq!(
            forwarded_request.client_address.as_deref(),
            Some("192.0.2.1")
        );
    }

    /// A log writer that falls behind never slows the API: with the channel
    /// full the request is still answered, and the report is dropped.
    #[tokio::test]
    async fn a_full_channel_drops_the_report_and_still_answers() {
        let (request_log_tx, mut receiver) = mpsc::channel(1);
        let router = reporting_router(request_log_tx);
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
