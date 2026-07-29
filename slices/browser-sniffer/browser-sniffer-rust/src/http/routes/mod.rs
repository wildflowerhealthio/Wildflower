//! HTTP routes for the browser-sniffer slice — the `/sniffer` control
//! endpoints as one [`openapi_router`], plus the `/sniffer/events` WebSocket
//! as a plain [`events_router`] (OpenAPI has no WS operation shape). The
//! served REST routes and the OpenAPI spec come from the same
//! `#[utoipa::path]`-annotated handlers.

mod sniffer;

use std::sync::Arc;

use axum::routing::get;
use axum::Router;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::live_bindings::state::SnifferState;

/// The REST half of the sniffer surface as an `OpenApiRouter` — the
/// spec-bearing inner of [`router`](super::router). Every route is scope-gated
/// per operation (the handlers take a `Scoped<…>` capability); the host
/// additionally wraps the built router with its bearer gate, which inserts the
/// `ScopeClaims` the capabilities read.
pub(crate) fn openapi_router() -> OpenApiRouter<Arc<SnifferState>> {
    OpenApiRouter::new()
        .routes(routes!(
            sniffer::open_webview::handle_open_webview,
            sniffer::dispose_webview::handle_dispose_webview
        ))
        .routes(routes!(sniffer::set_status::handle_set_status))
        .routes(routes!(sniffer::show_webview::handle_show_webview))
        .routes(routes!(sniffer::page_action::handle_page_action))
        .routes(routes!(sniffer::cancel_request::handle_cancel_request))
}

/// The `/sniffer/events` WebSocket route — merged alongside the REST routes in
/// [`router`](super::router), outside the OpenAPI document (see
/// [`sniffer::events_socket`]).
pub(crate) fn events_router() -> Router<Arc<SnifferState>> {
    Router::new().route(
        "/sniffer/events",
        get(sniffer::events_socket::handle_sniffer_events),
    )
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::Router;
    use http_body_util::BodyExt;
    use scope_capabilities_rust::ScopeClaims;
    use tower::ServiceExt;

    use crate::domain::test_fake::FakeWebviewHandle;
    use crate::domain::SnifferEvents;
    use crate::live_bindings::state::SnifferState;

    /// A `ScopeClaims` covering every `wildflower/Sniffer.*` operation — the
    /// grant an owner token carries. The gate itself has its own 403 tests
    /// below.
    const FULL_ACCESS: &str = "wildflower/Sniffer.cruds";

    fn state_over(handle: Arc<FakeWebviewHandle>) -> Arc<SnifferState> {
        Arc::new(SnifferState::new(handle, SnifferEvents::new()))
    }

    /// The served router (REST + WS routes, state applied per-call).
    fn router() -> Router<Arc<SnifferState>> {
        let (rest, _spec) = super::openapi_router().split_for_parts();
        rest.merge(super::events_router())
    }

    /// Drive one request with a `ScopeClaims` covering `scopes` inserted into
    /// the extensions — standing in for the host's bearer gate.
    async fn send_scoped(
        state: &Arc<SnifferState>,
        mut req: Request<Body>,
        scopes: &str,
    ) -> (StatusCode, serde_json::Value) {
        req.extensions_mut()
            .insert(ScopeClaims::new(Some(scopes.to_owned())));
        let res = router()
            .with_state(Arc::clone(state))
            .oneshot(req)
            .await
            .expect("oneshot");
        let status = res.status();
        let bytes = res.into_body().collect().await.expect("body").to_bytes();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    async fn send(
        state: &Arc<SnifferState>,
        req: Request<Body>,
    ) -> (StatusCode, serde_json::Value) {
        send_scoped(state, req, FULL_ACCESS).await
    }

    fn post_json(uri: &str, body: serde_json::Value) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    fn put_json(uri: &str, body: serde_json::Value) -> Request<Body> {
        Request::builder()
            .method("PUT")
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    fn post_empty(uri: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .body(Body::empty())
            .unwrap()
    }

    fn delete(uri: &str) -> Request<Body> {
        Request::builder()
            .method("DELETE")
            .uri(uri)
            .body(Body::empty())
            .unwrap()
    }

    /// The full control-plane round-trip a scripted run drives: open → status
    /// → page action → cancel → show → dispose, each a 204 that reached the
    /// host handle with the right argument, in order.
    #[tokio::test]
    async fn control_plane_round_trip_reaches_the_handle_in_order() {
        let handle = Arc::new(FakeWebviewHandle::default());
        let st = state_over(handle.clone());

        let (status, _b) = send(
            &st,
            post_json(
                "/sniffer/webview",
                serde_json::json!({
                    "source": { "_tag": "Uri", "uri": "https://emr.example.test/portal" },
                    "linkedSpan": { "traceId": "t1", "spanId": "s1" },
                }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        let (status, _b) = send(
            &st,
            put_json(
                "/sniffer/status",
                serde_json::json!({ "name": "Entering email" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        let (status, _b) = send(
            &st,
            post_json(
                "/sniffer/page-actions",
                serde_json::json!({ "action": { "kind": "Fill", "querySelector": "#email", "value": "u@x" } }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        let (status, _b) = send(
            &st,
            post_json(
                "/sniffer/cancellations",
                serde_json::json!({ "id": "req-9" }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        let (status, _b) = send(&st, post_empty("/sniffer/visibility")).await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        let (status, _b) = send(&st, delete("/sniffer/webview")).await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        assert_eq!(
            handle.calls(),
            vec![
                "open_or_navigate:https://emr.example.test/portal".to_owned(),
                "set_status:Entering email".to_owned(),
                r##"forward:{"_tag":"PageAction","action":{"kind":"Fill","querySelector":"#email","value":"u@x"}}"##
                    .to_owned(),
                r#"forward:{"_tag":"CancelSnifferRequest","id":"req-9"}"#.to_owned(),
                "show".to_owned(),
                "dispose".to_owned(),
            ],
        );
    }

    /// A rejected source is the modelled 400 — the acknowledgement the bridge's
    /// warn-and-drop never gave — and the handle is never asked to navigate.
    #[tokio::test]
    async fn a_rejected_source_is_a_structured_400() {
        let handle = Arc::new(FakeWebviewHandle::default());
        let st = state_over(handle.clone());
        for source in [
            serde_json::json!({ "_tag": "Uri", "uri": "javascript:alert(1)" }),
            serde_json::json!({ "_tag": "Html", "html": "<html></html>" }),
        ] {
            let (status, body) = send(
                &st,
                post_json("/sniffer/webview", serde_json::json!({ "source": source })),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert_eq!(body["error"], "InvalidSource");
        }
        assert!(handle.calls().is_empty(), "the handle was never called");
    }

    /// A failing host handle is an opaque 500 — no client-decodable body.
    #[tokio::test]
    async fn a_failing_handle_is_an_opaque_500() {
        let st = state_over(Arc::new(FakeWebviewHandle::failing()));
        let (status, body) = send(&st, post_empty("/sniffer/visibility")).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body, serde_json::Value::Null, "the 500 carries no body");
    }

    /// Every mutating endpoint is gated by `wildflower/Sniffer.c` — a token
    /// with only the observer's read scope is 403-ed, naming the missing
    /// scope, and the handle is untouched.
    #[tokio::test]
    async fn control_endpoints_403_without_the_drive_scope() {
        let handle = Arc::new(FakeWebviewHandle::default());
        let st = state_over(handle.clone());
        let read_only = "wildflower/Sniffer.r";
        let requests = [
            post_json(
                "/sniffer/webview",
                serde_json::json!({ "source": { "_tag": "Uri", "uri": "https://x.test/" } }),
            ),
            put_json("/sniffer/status", serde_json::json!({ "name": "n" })),
            post_json(
                "/sniffer/page-actions",
                serde_json::json!({ "action": { "kind": "Click", "querySelector": "#a" } }),
            ),
            post_json("/sniffer/cancellations", serde_json::json!({ "id": "r" })),
            post_empty("/sniffer/visibility"),
            delete("/sniffer/webview"),
        ];
        for req in requests {
            let (method, uri) = (req.method().clone(), req.uri().clone());
            let (status, body) = send_scoped(&st, req, read_only).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}");
            assert_eq!(body["error"], "InsufficientScope", "{method} {uri}");
            assert_eq!(
                body["missingScopes"],
                serde_json::json!(["wildflower/Sniffer.c"]),
                "{method} {uri}",
            );
        }
        assert!(
            handle.calls().is_empty(),
            "no rejected call reached the handle"
        );
    }

    /// The event stream is gated by `wildflower/Sniffer.r` — a drive-only
    /// token can't read the sniffed pages' bodies. (The scope check runs
    /// before the WS upgrade, so this is an ordinary 403.)
    #[tokio::test]
    async fn the_event_stream_403s_without_the_read_scope() {
        let st = state_over(Arc::new(FakeWebviewHandle::default()));
        let req = Request::builder()
            .uri("/sniffer/events")
            .body(Body::empty())
            .unwrap();
        let (status, body) = send_scoped(&st, req, "wildflower/Sniffer.c").await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(
            body["missingScopes"],
            serde_json::json!(["wildflower/Sniffer.r"]),
        );
    }

    /// A `Scoped<…>` handler mounted without a claims-inserting layer is a
    /// wiring bug — the extractor fails closed with a 500 rather than
    /// admitting the request.
    #[tokio::test]
    async fn missing_claims_fails_closed_with_a_500() {
        let st = state_over(Arc::new(FakeWebviewHandle::default()));
        let res = router()
            .with_state(Arc::clone(&st))
            .oneshot(post_empty("/sniffer/visibility"))
            .await
            .expect("oneshot");
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
}
