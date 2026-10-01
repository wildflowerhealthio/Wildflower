//! The outermost layer of the served stack: after each request the trusted
//! front relayed through the tunnel, report who made it to the host.
//!
//! The caller is read off the response's [`RequestCaller`] extension, which
//! the gatekeeper bearer gates and the subdomain reverse proxy stamp (see
//! `shared_structures_rust::request_caller`). The host turns the reports into
//! "this app is using your server" notifications.

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use shared_structures_rust::request_caller::{ForwardedRequest, RequestCaller};
use shared_structures_rust::served_origin::is_forwarded;
use tokio::sync::mpsc;

/// Report a [`ForwardedRequest`] on `forwarded_request_sender` once the
/// response to a forwarded request is ready. A loopback request is not
/// reported.
///
/// The forwarded test is [`is_forwarded`], the same presence-only predicate the
/// loopback owner trust keys on, so a request with a malformed `Forwarded`
/// header is reported too.
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
    let request_was_forwarded = is_forwarded(request.headers());
    let response = next.run(request).await;
    if request_was_forwarded {
        let forwarded_request = ForwardedRequest {
            caller: response.extensions().get::<RequestCaller>().cloned(),
        };
        if let Err(error) = forwarded_request_sender.try_send(forwarded_request) {
            tracing::debug!("forwarded-request report dropped: {error}");
        }
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt;

    /// A router whose `/app` response is stamped with a self-hosted app caller
    /// and whose `/anonymous` response carries no caller, wrapped in the layer.
    fn reporting_router(forwarded_request_sender: mpsc::Sender<ForwardedRequest>) -> Router {
        Router::new()
            .route(
                "/app",
                get(|| async {
                    let mut response = Response::new(Body::from("app"));
                    response
                        .extensions_mut()
                        .insert(RequestCaller::SelfHostedApp {
                            app_id: "lifting".to_owned(),
                        });
                    response
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

    #[tokio::test]
    async fn a_forwarded_request_reports_the_stamped_caller() {
        let (sender, mut receiver) = mpsc::channel(4);
        let response = reporting_router(sender)
            .oneshot(forwarded_get("/app"))
            .await
            .expect("oneshot");

        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert_eq!(
            receiver.try_recv(),
            Ok(ForwardedRequest {
                caller: Some(RequestCaller::SelfHostedApp {
                    app_id: "lifting".to_owned()
                })
            })
        );
    }

    #[tokio::test]
    async fn a_forwarded_request_with_no_caller_reports_none() {
        let (sender, mut receiver) = mpsc::channel(4);
        reporting_router(sender)
            .oneshot(forwarded_get("/anonymous"))
            .await
            .expect("oneshot");

        assert_eq!(receiver.try_recv(), Ok(ForwardedRequest { caller: None }));
    }

    /// A malformed `Forwarded` header still came through the front, so it is
    /// reported, as the owner trust treats it as forwarded.
    #[tokio::test]
    async fn a_malformed_forwarded_header_is_still_reported() {
        let (sender, mut receiver) = mpsc::channel(4);
        let request = Request::get("/anonymous")
            .header("forwarded", "junk-with-no-recognized-params")
            .body(Body::empty())
            .expect("request");
        reporting_router(sender)
            .oneshot(request)
            .await
            .expect("oneshot");

        assert_eq!(receiver.try_recv(), Ok(ForwardedRequest { caller: None }));
    }

    #[tokio::test]
    async fn a_loopback_request_is_not_reported() {
        let (sender, mut receiver) = mpsc::channel(4);
        let request = Request::get("/app").body(Body::empty()).expect("request");
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
            assert_eq!(response.status(), axum::http::StatusCode::OK);
        }

        assert_eq!(receiver.try_recv(), Ok(ForwardedRequest { caller: None }));
        assert_eq!(
            receiver.try_recv(),
            Err(mpsc::error::TryRecvError::Empty),
            "the second report overflowed the one-slot channel"
        );
    }
}
