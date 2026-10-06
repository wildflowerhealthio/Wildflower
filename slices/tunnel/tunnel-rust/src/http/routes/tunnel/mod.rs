//! `/tunnel` routes — the host-side, read-only view of the tunnel. The one
//! operation (`get`) is a `#[utoipa::path]`-annotated handler; its wire shape
//! lives in [`wire_representations`]. [`openapi_router`] is the only path
//! table, collecting the `OpenAPI` spec from the very handler that serves
//! traffic. The relay settings come from the server's record, so nothing here
//! writes them.

mod get;
mod wire_representations;

use std::sync::Arc;

use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::live_bindings::state::TunnelState;

pub(crate) fn openapi_router() -> OpenApiRouter<Arc<TunnelState>> {
    OpenApiRouter::new().routes(routes!(get::handle_get_tunnel))
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;
    use tower::ServiceExt;

    use scope_capabilities_rust::ScopeClaims;
    use shared_structures_rust::tunnel_service::TunnelStatus;

    use super::*;
    use crate::domain::{RelayClient, RelaySettings};
    use crate::health::HealthProbe;
    use crate::test_support::{relay, StubProbe};
    use crate::TunnelDaemon;

    /// The scope claim `GET /tunnel` requires — the owner-shaped token the
    /// behavioural tests present so the scope gate never rejects them. The host
    /// wraps this router with an authN layer that inserts a `ScopeClaims`; the
    /// tests do the same via a request extension.
    const READ_SCOPE: &str = "wildflower/TunnelSettings.r";

    /// The plain axum router (`OpenAPI` spec discarded) for exercising the
    /// handler via `oneshot` — the documented router minus its spec half.
    fn router() -> axum::Router<Arc<TunnelState>> {
        openapi_router().split_for_parts().0
    }

    /// What a fake attempt does once started.
    #[derive(Clone, Copy)]
    enum Behavior {
        /// Hold the tunnel up until cancelled, then stop cleanly (a healthy run).
        HoldUntilCancel,
        /// Fail immediately (drives the reconnect loop).
        FailImmediately,
    }

    /// Fake relay client: signals each attempt on a channel so tests can await
    /// attempts deterministically, then behaves per `Behavior`.
    struct FakeClient {
        behavior: Behavior,
        started: mpsc::UnboundedSender<()>,
    }

    #[async_trait::async_trait]
    impl RelayClient for FakeClient {
        async fn run_once(
            &self,
            _relay: &RelaySettings,
            _local_addr: &str,
            cancel: CancellationToken,
        ) -> anyhow::Result<()> {
            let _ = self.started.send(());
            match self.behavior {
                Behavior::HoldUntilCancel => {
                    cancel.cancelled().await;
                    Ok(())
                }
                Behavior::FailImmediately => Err(anyhow::anyhow!("relay unreachable")),
            }
        }
    }

    /// The tunnel state over a daemon dialing `dev1.example.com`'s relay. A
    /// failing `probe` keeps the tunnel off `Verified`, so `servedOrigin` stays
    /// deterministically on the loopback fallback.
    fn state(
        behavior: Behavior,
        probe: Arc<dyn HealthProbe>,
    ) -> (Arc<TunnelState>, mpsc::UnboundedReceiver<()>) {
        let (started, rx) = mpsc::unbounded_channel();
        let client = Arc::new(FakeClient { behavior, started });
        let state = Arc::new(TunnelState {
            daemon: Arc::new(TunnelDaemon::spawn_test(
                client,
                probe,
                relay(),
                "dev1.example.com",
            )),
        });
        (state, rx)
    }

    fn failing_probe() -> Arc<dyn HealthProbe> {
        Arc::new(StubProbe::failing())
    }

    async fn send(state: &Arc<TunnelState>, req: Request<Body>) -> (StatusCode, serde_json::Value) {
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

    fn get() -> Request<Body> {
        get_as(READ_SCOPE)
    }

    /// A `GET /tunnel` carrying exactly `scopes`, for exercising the read gate.
    fn get_as(scopes: &str) -> Request<Body> {
        Request::builder()
            .uri("/tunnel")
            .extension(ScopeClaims::new(Some(scopes.to_owned())))
            .body(Body::empty())
            .unwrap()
    }

    /// `GET /tunnel` carries the liveness and the public host from the record,
    /// and nothing else: no relay settings, no run intent, no settings
    /// revision. The failing probe keeps it on the loopback fallback.
    #[tokio::test]
    async fn get_reads_the_liveness_and_the_public_host_only() {
        let (st, _started) = state(Behavior::HoldUntilCancel, failing_probe());
        let (status, body) = send(&st, get()).await;
        assert_eq!(status, StatusCode::OK);
        let mut keys: Vec<&str> = body
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "dialAttempts",
                "error",
                "publicHost",
                "running",
                "servedOrigin",
                "status"
            ],
        );
        assert_eq!(body["publicHost"], serde_json::json!("dev1.example.com"));
        assert_eq!(body["running"], serde_json::json!(true));
        assert_eq!(
            body["servedOrigin"],
            serde_json::json!("http://127.0.0.1:8080")
        );
    }

    /// Once a `/health` probe comes back healthy, the status flips to
    /// `verified` and `servedOrigin` becomes the public origin.
    #[tokio::test(start_paused = true)]
    async fn verified_after_probe_reports_the_public_origin() {
        let (st, _started) = state(Behavior::HoldUntilCancel, Arc::new(StubProbe::passing()));
        st.daemon
            .watch_liveness()
            .wait_for(|l| l.status == TunnelStatus::Verified)
            .await
            .expect("verified");
        let (_status, body) = send(&st, get()).await;
        assert_eq!(body["status"], serde_json::json!("verified"));
        assert_eq!(
            body["servedOrigin"],
            serde_json::json!("https://dev1.example.com")
        );
    }

    #[tokio::test]
    async fn a_failed_attempt_surfaces_the_error_and_keeps_retrying() {
        let (st, mut started) = state(Behavior::FailImmediately, failing_probe());
        let mut live = st.daemon.watch_liveness();

        // the supervisor's dial fails and surfaces `unreachable` + the error
        // (deterministic await on the liveness transition)
        live.wait_for(|l| {
            l.status == TunnelStatus::Unreachable && l.error.as_deref() == Some("relay unreachable")
        })
        .await
        .expect("error surfaces");
        // and it keeps reconnecting — at least two attempts happen
        started.recv().await.expect("attempt 1");
        started.recv().await.expect("attempt 2");

        // The attempt counter climbs on every retry so an operator can spot a
        // permanent misconfiguration (steady error + steadily climbing count).
        live.wait_for(|l| l.dial_attempts >= 2)
            .await
            .expect("attempt count climbs");
        let (_, body) = send(&st, get()).await;
        assert!(
            body["dialAttempts"].as_i64().expect("attempt is a number") >= 2,
            "wire surfaces the climbing attempt count: {body}",
        );
    }

    /// The web app can't write the tunnel: `/tunnel` serves no `PUT`, even to a
    /// token holding every tunnel permission.
    #[tokio::test]
    async fn put_is_method_not_allowed() {
        let (st, _started) = state(Behavior::HoldUntilCancel, failing_probe());
        let req = Request::builder()
            .method("PUT")
            .uri("/tunnel")
            .header("content-type", "application/json")
            .extension(ScopeClaims::new(Some(
                "wildflower/TunnelSettings.cruds".to_owned(),
            )))
            .body(Body::from(
                serde_json::json!({ "publicHost": "evil.example.com" }).to_string(),
            ))
            .unwrap();
        let res = router()
            .with_state(Arc::clone(&st))
            .oneshot(req)
            .await
            .expect("oneshot");
        assert_eq!(res.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    /// `GET /tunnel` is gated by `wildflower/TunnelSettings.r`: a token that
    /// doesn't cover it is rejected with the shared `403` naming the missing
    /// scope.
    #[tokio::test]
    async fn get_without_the_read_scope_is_403() {
        let (st, _started) = state(Behavior::HoldUntilCancel, failing_probe());
        let (status, body) = send(&st, get_as("wildflower/Apps.r")).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "body: {body}");
        assert_eq!(body["error"], serde_json::json!("InsufficientScope"));
        assert_eq!(
            body["missingScopes"],
            serde_json::json!(["wildflower/TunnelSettings.r"]),
        );
    }

    /// A request without a `ScopeClaims` extension is a wiring bug (the authN
    /// layer that inserts it didn't run). The `Scoped` extractor fails closed
    /// with a `500` rather than admit the request, so a mis-mounted router can't
    /// bypass the gate.
    #[tokio::test]
    async fn a_request_without_claims_fails_closed_with_500() {
        let (st, _started) = state(Behavior::HoldUntilCancel, failing_probe());
        // No `ScopeClaims` extension on the request.
        let req = Request::builder()
            .uri("/tunnel")
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
