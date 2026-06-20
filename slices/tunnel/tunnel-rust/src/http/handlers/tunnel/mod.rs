//! `/tunnel` routes — the host-side surface for reading and replacing tunnel
//! settings. One module per route handler (`get`, `put`), each a
//! `#[utoipa::path]`-annotated handler; shared wire types live in
//! [`tunnel_state_response`]. [`openapi_router`] is the only path table — the
//! two methods on `/tunnel` (GET + PUT) share the path and `routes!` merges
//! them, collecting the `OpenAPI` spec from the very handlers that serve traffic.

mod get;
mod put;
mod tunnel_state_response;

use std::sync::Arc;

use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::http::state::TunnelState;

pub(crate) fn openapi_router() -> OpenApiRouter<Arc<TunnelState>> {
    OpenApiRouter::new().routes(routes!(get::handle_get_tunnel, put::handle_put_tunnel))
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;
    use tower::ServiceExt;

    use super::*;
    use crate::db::TunnelStore;
    use crate::domain::{RelayClient, RelaySettings};
    use crate::health::HealthProbe;
    use crate::test_support::StubProbe;
    use crate::TunnelDaemon;

    /// The wire tests default to a *failing* probe so the tunnel never reaches
    /// `Verified` — keeping `servedOrigin` deterministically on the loopback
    /// fallback regardless of real-time probe ticks. The verified path has its
    /// own paused-time test.
    fn failing_probe() -> Arc<dyn HealthProbe> {
        Arc::new(StubProbe(Err("probe disabled in test".to_string())))
    }

    fn passing_probe() -> Arc<dyn HealthProbe> {
        Arc::new(StubProbe(Ok(())))
    }

    /// The plain axum router (`OpenAPI` spec discarded) for exercising the
    /// handlers via `oneshot` — the documented router minus its spec half.
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

    fn state(behavior: Behavior) -> (Arc<TunnelState>, mpsc::UnboundedReceiver<()>) {
        state_with_probe(behavior, failing_probe())
    }

    fn state_with_probe(
        behavior: Behavior,
        probe: Arc<dyn HealthProbe>,
    ) -> (Arc<TunnelState>, mpsc::UnboundedReceiver<()>) {
        let (started, rx) = mpsc::unbounded_channel();
        let client = Arc::new(FakeClient { behavior, started });
        let store = TunnelStore::open_in_memory().expect("store");
        let state = Arc::new(TunnelState {
            store,
            daemon: TunnelDaemon::new_test(client, probe, "http://127.0.0.1:8080", 8080),
        });
        (state, rx)
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
        Request::builder()
            .uri("/tunnel")
            .body(Body::empty())
            .unwrap()
    }

    fn put(json: &serde_json::Value) -> Request<Body> {
        Request::builder()
            .method("PUT")
            .uri("/tunnel")
            .header("content-type", "application/json")
            .body(Body::from(json.to_string()))
            .unwrap()
    }

    fn relay_json() -> serde_json::Value {
        serde_json::json!({
            "remoteAddr": "relay.example.com:2333",
            "token": "tok",
            "publicKey": "key",
            "serviceName": "dev1",
        })
    }

    #[tokio::test]
    async fn fresh_state_is_the_schema_shaped_default() {
        let (st, _started) = state(Behavior::HoldUntilCancel);
        let (status, body) = send(&st, get()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            serde_json::json!({
                "settingsRevision": 0,
                "publicHost": null,
                "requestedRunning": false,
                "status": "off",
                "running": false,
                "error": null,
                "dialAttempts": 0,
                "servedOrigin": "http://127.0.0.1:8080",
                "relay": null,
            })
        );
    }

    /// The immediate PUT response is `dialing`: the supervisor has been spawned
    /// (`running` true) but no `/health` probe has verified reachability yet, so
    /// `servedOrigin` stays on the loopback fallback — not the optimistic public
    /// origin the old behaviour reported.
    #[tokio::test]
    async fn put_with_relay_running_reports_dialing_and_bumps_revision() {
        let (st, _started) = state(Behavior::HoldUntilCancel);
        let (status, body) = send(
            &st,
            put(&serde_json::json!({
                "settingsRevision": 0,
                "publicHost": "dev1.example.com",
                "requestedRunning": true,
                "relay": relay_json(),
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["settingsRevision"], serde_json::json!(1));
        assert_eq!(body["status"], serde_json::json!("dialing"));
        assert_eq!(body["running"], serde_json::json!(true), "supervisor up");
        assert_eq!(
            body["servedOrigin"],
            serde_json::json!("http://127.0.0.1:8080"),
            "loopback until a probe verifies",
        );
    }

    /// Once a `/health` probe comes back healthy, the status
    /// flips to `verified` and `servedOrigin` becomes the public origin.
    #[tokio::test(start_paused = true)]
    async fn verified_after_probe_reports_the_public_origin() {
        let (st, _started) = state_with_probe(Behavior::HoldUntilCancel, passing_probe());
        let _ = send(
            &st,
            put(&serde_json::json!({
                "settingsRevision": 0,
                "publicHost": "dev1.example.com",
                "requestedRunning": true,
                "relay": relay_json(),
            })),
        )
        .await;
        // Wait for the supervisor's probe to verify in virtual time.
        let mut live = st.daemon.watch_liveness();
        live.wait_for(|l| l.origin == "https://dev1.example.com")
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
    async fn relay_is_returned_without_the_secret_token() {
        let (st, _started) = state(Behavior::HoldUntilCancel);
        let _ = send(
            &st,
            put(&serde_json::json!({
                "settingsRevision": 0, "publicHost": "dev1.example.com",
                "requestedRunning": true, "relay": relay_json(),
            })),
        )
        .await;
        let (_status, body) = send(&st, get()).await;
        // The non-secret relay fields are returned so the UI can prefill them.
        let relay = body["relay"].as_object().expect("relay object returned");
        assert_eq!(
            relay["remoteAddr"],
            serde_json::json!("relay.example.com:2333")
        );
        assert_eq!(relay["publicKey"], serde_json::json!("key"));
        assert_eq!(relay["serviceName"], serde_json::json!("dev1"));
        // The token stays write-only — never inside the relay object...
        assert!(!relay.contains_key("token"), "token stays write-only");
        // ...nor leaked as a bare top-level key.
        let obj = body.as_object().unwrap();
        for k in ["token", "relayToken", "relayRemoteAddr", "serviceName"] {
            assert!(
                !obj.contains_key(k),
                "wire must not expose {k} at top level"
            );
        }
    }

    #[tokio::test]
    async fn put_with_stale_revision_conflicts_and_returns_current() {
        let (st, _started) = state(Behavior::HoldUntilCancel);
        let _ = send(
            &st,
            put(&serde_json::json!({
                "settingsRevision": 0, "publicHost": "dev1", "requestedRunning": true, "relay": relay_json(),
            })),
        )
        .await;
        // a second writer still on revision 0 loses
        let (status, body) = send(
            &st,
            put(&serde_json::json!({ "settingsRevision": 0, "publicHost": "evil", "requestedRunning": false })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            body["settingsRevision"],
            serde_json::json!(1),
            "current revision"
        );
        assert_eq!(body["publicHost"], serde_json::json!("dev1"), "unchanged");
    }

    #[tokio::test]
    async fn requested_on_without_relay_reports_not_configured() {
        let (st, _started) = state(Behavior::HoldUntilCancel);
        let (_status, body) = send(
            &st,
            put(&serde_json::json!({
                "settingsRevision": 0, "publicHost": "dev1.example.com", "requestedRunning": true,
            })),
        )
        .await;
        assert_eq!(body["status"], serde_json::json!("misconfigured"));
        assert_eq!(body["running"], serde_json::json!(false));
        assert_eq!(
            body["error"],
            serde_json::json!("tunnel relay is not configured")
        );
        assert_eq!(
            body["servedOrigin"],
            serde_json::json!("http://127.0.0.1:8080"),
            "loopback while down"
        );
    }

    #[tokio::test]
    async fn a_failed_attempt_surfaces_the_error_and_keeps_retrying() {
        use shared_structures_rust::tunnel_service::TunnelStatus;
        let (st, mut started) = state(Behavior::FailImmediately);
        let mut live = st.daemon.watch_liveness();
        let _ = send(
            &st,
            put(&serde_json::json!({
                "settingsRevision": 0, "publicHost": "dev1.example.com",
                "requestedRunning": true, "relay": relay_json(),
            })),
        )
        .await;

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

    /// `publicHost` is a full-replace field, not optional — omitting it must
    /// be a client error, not a silent NULL write that wipes a configured
    /// host. (Contrast with the write-only `relay` block, which is optional
    /// because clients can't echo back what they never see.)
    #[tokio::test]
    async fn put_without_public_host_is_rejected() {
        let (st, _started) = state(Behavior::HoldUntilCancel);
        // Don't use `send` — axum's Json rejection body isn't JSON, so we
        // only check the status here.
        let res = router()
            .with_state(Arc::clone(&st))
            .oneshot(put(&serde_json::json!(
                { "settingsRevision": 0, "requestedRunning": false }
            )))
            .await
            .expect("oneshot");
        assert!(
            res.status().is_client_error(),
            "PUT body lacking publicHost must be a 4xx, got {}",
            res.status(),
        );
    }

    /// An explicit `publicHost: null` is the documented way to clear the host
    /// — distinct from omission, which is rejected.
    #[tokio::test]
    async fn put_with_explicit_null_public_host_clears_it() {
        let (st, _started) = state(Behavior::HoldUntilCancel);
        let _ = send(
            &st,
            put(&serde_json::json!({
                "settingsRevision": 0,
                "publicHost": "dev1.example.com",
                "requestedRunning": true,
                "relay": relay_json(),
            })),
        )
        .await;
        let (status, body) = send(
            &st,
            put(&serde_json::json!({
                "settingsRevision": 1,
                "publicHost": serde_json::Value::Null,
                "requestedRunning": true,
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["publicHost"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn turning_off_stops_the_tunnel_and_returns_to_loopback() {
        let (st, _started) = state(Behavior::HoldUntilCancel);
        let _ = send(
            &st,
            put(&serde_json::json!({
                "settingsRevision": 0, "publicHost": "dev1.example.com",
                "requestedRunning": true, "relay": relay_json(),
            })),
        )
        .await;
        let (_status, body) = send(
            &st,
            put(&serde_json::json!({ "settingsRevision": 1, "publicHost": "dev1.example.com", "requestedRunning": false })),
        )
        .await;
        assert_eq!(body["settingsRevision"], serde_json::json!(2));
        assert_eq!(body["status"], serde_json::json!("off"));
        assert_eq!(body["running"], serde_json::json!(false));
        assert_eq!(
            body["servedOrigin"],
            serde_json::json!("http://127.0.0.1:8080")
        );
    }
}
