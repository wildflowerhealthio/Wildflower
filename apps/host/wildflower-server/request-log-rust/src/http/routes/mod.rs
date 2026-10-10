//! HTTP routes for the request-log slice — `GET /requests` and
//! `GET /requests/callers` as one [`openapi_router`]. The served routes and the
//! OpenAPI spec come from the same `#[utoipa::path]`-annotated handlers.

mod requests;

use std::sync::Arc;

use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::live_bindings::state::RequestLogState;

/// The whole request-log surface as an `OpenApiRouter` — the spec-bearing inner
/// of [`router`](super::router). Every route is scope-gated (the handlers take a
/// `Scoped<…>` capability); the server additionally wraps the built router with
/// its bearer gate, which inserts the `ScopeClaims` the capability reads.
pub(crate) fn openapi_router() -> OpenApiRouter<Arc<RequestLogState>> {
    OpenApiRouter::new()
        .routes(routes!(requests::callers::handle_list_callers))
        .routes(routes!(requests::list::handle_list_requests))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::SystemTime;

    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::Router;
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    use wildflowerhealthio_scope_capabilities::ScopeClaims;
    use wildflowerhealthio_shared_structures::request_caller::RequestRefusal;

    use crate::db::logged_requests::test_support::forwarded_request;
    use crate::db::SqliteRequestLogStore;
    use crate::domain::RequestLogStore;
    use crate::live_bindings::state::RequestLogState;

    /// The scope an owner-shaped token carries for the request log, so the
    /// behavioural tests never trip the scope gate. The server wraps this
    /// router with an authN layer that inserts a `ScopeClaims`; the tests do
    /// the same via a request extension.
    const READ_SCOPE: &str = "wildflower/RequestLog.r";

    /// The served router (state applied per call); the spec half of
    /// `split_for_parts` is irrelevant in the handler tests.
    fn router() -> Router<Arc<RequestLogState>> {
        super::openapi_router().split_for_parts().0
    }

    /// A state whose log holds a served request from `lifting` and, after it, a
    /// refused one from no verified caller.
    fn state_with_logged_requests() -> Arc<RequestLogState> {
        let store = SqliteRequestLogStore::open_in_memory().expect("store");
        let mut refused = forwarded_request(None, SystemTime::now());
        refused.client_address = Some("203.0.113.9".to_owned());
        refused.refusal = Some(RequestRefusal::MissingToken);
        store
            .insert_requests(&[
                forwarded_request(Some("lifting"), SystemTime::now()),
                refused,
            ])
            .expect("log requests");
        Arc::new(RequestLogState::new(store))
    }

    /// A `GET` of `uri` carrying exactly `scopes`.
    fn get_as(uri: &str, scopes: &str) -> Request<Body> {
        Request::builder()
            .uri(uri)
            .extension(ScopeClaims::new(Some(scopes.to_owned())))
            .body(Body::empty())
            .unwrap()
    }

    async fn send(
        state: &Arc<RequestLogState>,
        req: Request<Body>,
    ) -> (StatusCode, serde_json::Value) {
        let res = router()
            .with_state(Arc::clone(state))
            .oneshot(req)
            .await
            .expect("oneshot");
        let status = res.status();
        let bytes = res.into_body().collect().await.expect("body").to_bytes();
        let json = serde_json::from_slice(&bytes).expect("json");
        (status, json)
    }

    #[tokio::test]
    async fn callers_lists_each_caller_and_address_newest_first() {
        let st = state_with_logged_requests();
        let (status, body) = send(&st, get_as("/requests/callers", READ_SCOPE)).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        let callers = body.as_array().expect("an array");
        assert_eq!(callers.len(), 2);
        assert_eq!(callers[0]["clientId"], serde_json::Value::Null);
        assert_eq!(callers[0]["address"], "203.0.113.9");
        assert_eq!(callers[0]["refusedCount"], 1);
        assert_eq!(callers[0]["lastStatus"], 401);
        assert_eq!(callers[0]["lastRefusal"], "missingToken");
        assert_eq!(callers[1]["clientId"], "lifting");
        assert_eq!(callers[1]["requestCount"], 1);
        assert_eq!(callers[1]["lastRefusal"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn requests_pages_the_log_and_applies_the_filters() {
        let st = state_with_logged_requests();
        let (status, body) = send(&st, get_as("/requests", READ_SCOPE)).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["nextCursor"], serde_json::Value::Null);
        let requests = body["requests"].as_array().expect("an array");
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0]["id"], 2);
        assert_eq!(requests[0]["refusal"], "missingToken");
        assert_eq!(requests[1]["clientId"], "lifting");
        assert_eq!(requests[1]["path"], "/fhir-r4/Patient");
        assert_eq!(requests[1]["durationMs"], 12);

        let (_, refused) = send(&st, get_as("/requests?auth=refused", READ_SCOPE)).await;
        assert_eq!(refused["requests"].as_array().map(Vec::len), Some(1));
        assert_eq!(refused["requests"][0]["id"], 2);
        let (_, authorized) = send(&st, get_as("/requests?auth=authorized", READ_SCOPE)).await;
        assert_eq!(authorized["requests"].as_array().map(Vec::len), Some(1));
        assert_eq!(authorized["requests"][0]["id"], 1);
        let (_, public) = send(&st, get_as("/requests?auth=public", READ_SCOPE)).await;
        assert_eq!(public["requests"].as_array().map(Vec::len), Some(0));
        let (_, lifting) = send(&st, get_as("/requests?client=lifting&cursor=2", READ_SCOPE)).await;
        assert_eq!(lifting["requests"][0]["id"], 1);
    }

    /// The request log is gated by `wildflower/RequestLog.r`: a token without
    /// it — here one holding the tunnel's read scope — is refused with the
    /// shared `403` before anything is read.
    #[tokio::test]
    async fn the_request_log_without_the_read_scope_is_403() {
        let st = state_with_logged_requests();
        for uri in ["/requests/callers", "/requests"] {
            let (status, body) = send(&st, get_as(uri, "wildflower/Apps.r")).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{uri}: {body}");
            assert_eq!(body["error"], serde_json::json!("InsufficientScope"));
            assert_eq!(
                body["missingScopes"],
                serde_json::json!(["wildflower/RequestLog.r"]),
            );
        }
    }

    /// A request without a `ScopeClaims` extension is a wiring bug (the authN
    /// layer that inserts it didn't run). The `Scoped` extractor fails closed
    /// with a `500` rather than admit the request, so a mis-mounted router can't
    /// bypass the gate.
    #[tokio::test]
    async fn a_request_without_claims_fails_closed_with_500() {
        let st = state_with_logged_requests();
        let req = Request::builder()
            .uri("/requests")
            .body(Body::empty())
            .unwrap();
        let res = router()
            .with_state(Arc::clone(&st))
            .oneshot(req)
            .await
            .expect("oneshot");
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
}
