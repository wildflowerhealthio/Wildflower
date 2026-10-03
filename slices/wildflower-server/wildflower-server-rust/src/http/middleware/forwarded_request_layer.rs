//! The outermost layer of the served stack: after each request the trusted
//! front relayed through the tunnel, report what it was and who made it to the
//! host.
//!
//! The caller is read off the response's [`RequestCaller`] extension, and a
//! bearer gate's `401` off its [`RequestRefusal`] one; the gatekeeper bearer
//! gates stamp both (see `shared_structures_rust::request_caller`). The host
//! turns the reports into "this app is using your server" notifications.

mod reduced_path;

use std::time::{Instant, SystemTime};

use axum::body::HttpBody;
use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use shared_structures_rust::request_caller::{ForwardedRequest, RequestCaller, RequestRefusal};
use shared_structures_rust::served_origin::{
    forwarded_client_address, is_forwarded, request_provenance, RequestProvenance,
};
use tokio::sync::mpsc;

use reduced_path::reduced_path;

/// Report a [`ForwardedRequest`] on `forwarded_request_sender` once the
/// response to a forwarded request is ready. A loopback request is not
/// reported.
///
/// The forwarded test is [`is_forwarded`], the same presence-only predicate the
/// loopback owner trust keys on, so a request with a malformed `Forwarded`
/// header is reported too, with no client address or served host.
///
/// # Remarks
///
/// The report uses `try_send`, and a full channel drops it with a debug log.
/// This is the one place a dropped value is the right outcome: the report is an
/// observation feeding a best-effort notification count, and the alternative,
/// awaiting room in the channel, would hold a patient's FHIR response hostage to
/// how fast the host drains notifications. A closed channel (the host stopped
/// listening) is dropped the same way, since there is nobody left to tell.
pub(crate) async fn report_forwarded_request(
    State(forwarded_request_sender): State<mpsc::Sender<ForwardedRequest>>,
    request: Request,
    next: Next,
) -> Response {
    if !is_forwarded(request.headers()) {
        return next.run(request).await;
    }
    let received_at = SystemTime::now();
    let started = Instant::now();
    let client_address = forwarded_client_address(request.headers()).map(str::to_owned);
    let served_host = match request_provenance(request.headers()) {
        Some(RequestProvenance::Forwarded { base_url }) => Some(base_url.authority().to_owned()),
        Some(RequestProvenance::Loopback) | None => None,
    };
    let method = request.method().to_string();
    let reduced_path = reduced_path(request.uri());

    let response = next.run(request).await;

    let forwarded_request = ForwardedRequest {
        received_at,
        client_address,
        served_host,
        method,
        reduced_path,
        status: response.status().as_u16(),
        response_bytes: response.body().size_hint().exact(),
        duration: started.elapsed(),
        caller: response.extensions().get::<RequestCaller>().cloned(),
        refusal: response.extensions().get::<RequestRefusal>().copied(),
    };
    if let Err(error) = forwarded_request_sender.try_send(forwarded_request) {
        tracing::debug!("forwarded-request report dropped: {error}");
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
    /// slices do: `/fhir-r4/Patient/{id}` a `200` to the `lifting` client,
    /// `/access/grants` a scope `403` to it, `/refused/{refusal}` each bearer
    /// gate `401`, and `/anonymous` an ungated `200`.
    fn reporting_router(forwarded_request_sender: mpsc::Sender<ForwardedRequest>) -> Router {
        Router::new()
            .route(
                "/fhir-r4/Patient/{id}",
                get(|| async { stamped(StatusCode::OK, Some(lifting()), None) }),
            )
            .route(
                "/access/grants",
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
                forwarded_request_sender,
                report_forwarded_request,
            ))
    }

    fn forwarded_get(path: &str) -> Request {
        Request::get(path)
            .header(
                "forwarded",
                "for=192.0.2.1;host=demo.example.com;proto=https",
            )
            .body(Body::empty())
            .expect("request")
    }

    /// Send `request` through the layer and return the one record it reported.
    async fn reported(request: Request) -> ForwardedRequest {
        let (sender, mut receiver) = mpsc::channel(4);
        reporting_router(sender)
            .oneshot(request)
            .await
            .expect("oneshot");
        let forwarded_request = receiver.try_recv().expect("one record reported");
        assert_eq!(
            receiver.try_recv(),
            Err(mpsc::error::TryRecvError::Disconnected),
            "exactly one record per request"
        );
        forwarded_request
    }

    #[tokio::test]
    async fn a_forwarded_request_reports_its_record() {
        let before = SystemTime::now();
        let forwarded_request = reported(forwarded_get("/fhir-r4/Patient/123?_format=json")).await;

        assert!(forwarded_request.received_at >= before);
        assert!(forwarded_request.received_at <= SystemTime::now());
        assert_eq!(
            forwarded_request,
            ForwardedRequest {
                client_address: Some("192.0.2.1".to_owned()),
                served_host: Some("demo.example.com".to_owned()),
                method: "GET".to_owned(),
                reduced_path: "/fhir-r4/Patient".to_owned(),
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
        let forwarded_request = reported(forwarded_get("/access/grants")).await;

        assert_eq!(forwarded_request.status, 403);
        assert_eq!(forwarded_request.caller, Some(lifting()));
        assert_eq!(forwarded_request.refusal, None);
        assert_eq!(forwarded_request.reduced_path, "/access");
    }

    #[tokio::test]
    async fn each_401_reports_its_refusal_and_no_caller() {
        for (path, refusal) in [
            ("/refused/missing", RequestRefusal::MissingToken),
            ("/refused/rejected", RequestRefusal::TokenRejected),
            ("/refused/revoked", RequestRefusal::Revoked),
        ] {
            let forwarded_request = reported(forwarded_get(path)).await;
            assert_eq!(forwarded_request.status, 401, "{path}");
            assert_eq!(forwarded_request.refusal, Some(refusal), "{path}");
            assert_eq!(forwarded_request.caller, None, "{path}");
        }
    }

    #[tokio::test]
    async fn a_forwarded_request_with_no_caller_reports_none() {
        let forwarded_request = reported(forwarded_get("/anonymous")).await;

        assert_eq!(forwarded_request.caller, None);
        assert_eq!(forwarded_request.refusal, None);
    }

    /// A malformed `Forwarded` header still came through the front, so it is
    /// reported, as the owner trust treats it as forwarded, with no address or
    /// host it could vouch for.
    #[tokio::test]
    async fn a_malformed_forwarded_header_is_still_reported() {
        let request = Request::get("/anonymous")
            .header("forwarded", "junk-with-no-recognized-params")
            .body(Body::empty())
            .expect("request");
        let forwarded_request = reported(request).await;

        assert_eq!(forwarded_request.client_address, None);
        assert_eq!(forwarded_request.served_host, None);
        assert_eq!(forwarded_request.reduced_path, "/anonymous");
    }

    #[tokio::test]
    async fn a_loopback_request_is_not_reported() {
        let (sender, mut receiver) = mpsc::channel(4);
        let request = Request::get("/fhir-r4/Patient/123")
            .body(Body::empty())
            .expect("request");
        // Held, so the sender outlives the request and an empty channel reads
        // as "nothing reported", not "nobody left to report".
        let router = reporting_router(sender);
        router.clone().oneshot(request).await.expect("oneshot");

        assert_eq!(
            receiver.try_recv(),
            Err(mpsc::error::TryRecvError::Empty),
            "a loopback request must not be reported"
        );
    }

    /// A host that falls behind never slows the API: with the channel full the
    /// request is still answered, and the report is dropped.
    #[tokio::test]
    async fn a_full_channel_drops_the_report_and_still_answers() {
        let (sender, mut receiver) = mpsc::channel(1);
        let router = reporting_router(sender);
        for _ in 0..2 {
            let response = router
                .clone()
                .oneshot(forwarded_get("/anonymous"))
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
