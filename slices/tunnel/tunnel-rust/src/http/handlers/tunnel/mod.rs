//! `/tunnel` routes — the host-side surface for reading and replacing tunnel
//! settings. One module per route handler (`get`, `put`), each exposing a
//! `MethodRouter`; shared wire types and the snapshot helper live in
//! [`internal`]. `router()` is the only path table. The two methods on
//! `/tunnel` (GET + PUT) are merged here onto the shared path.

mod get;
mod put;
mod tunnel_state_response;

use std::sync::Arc;

use axum::Router;

use crate::http::state::TunnelState;

pub fn router() -> Router<Arc<TunnelState>> {
    Router::new().route("/tunnel", get::route().merge(put::route()))
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
    use crate::TunnelDaemon;

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
        let (started, rx) = mpsc::unbounded_channel();
        let client = Arc::new(FakeClient { behavior, started });
        let store = TunnelStore::open_in_memory().expect("store");
        let state = Arc::new(TunnelState {
            store,
            daemon: TunnelDaemon::new_test(client, "http://127.0.0.1:8080", 8080),
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

    fn put(json: serde_json::Value) -> Request<Body> {
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
                "revision": 0,
                "publicHost": null,
                "requestedRunning": false,
                "running": false,
                "error": null,
                "servedOrigin": "http://127.0.0.1:8080",
            })
        );
    }

    #[tokio::test]
    async fn put_with_relay_running_reports_public_origin_and_bumps_revision() {
        let (st, _started) = state(Behavior::HoldUntilCancel);
        let (status, body) = send(
            &st,
            put(serde_json::json!({
                "revision": 0,
                "publicHost": "dev1.example.com",
                "requestedRunning": true,
                "relay": relay_json(),
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["revision"], serde_json::json!(1));
        assert_eq!(body["running"], serde_json::json!(true), "optimistic up");
        assert_eq!(
            body["servedOrigin"],
            serde_json::json!("https://dev1.example.com")
        );
    }

    #[tokio::test]
    async fn relay_block_is_write_only_and_never_returned() {
        let (st, _started) = state(Behavior::HoldUntilCancel);
        let _ = send(
            &st,
            put(serde_json::json!({
                "revision": 0, "publicHost": "dev1.example.com",
                "requestedRunning": true, "relay": relay_json(),
            })),
        )
        .await;
        let (_status, body) = send(&st, get()).await;
        let obj = body.as_object().unwrap();
        for k in [
            "relay",
            "relayToken",
            "token",
            "relayRemoteAddr",
            "serviceName",
        ] {
            assert!(!obj.contains_key(k), "wire must not expose {k}");
        }
    }

    #[tokio::test]
    async fn put_with_stale_revision_conflicts_and_returns_current() {
        let (st, _started) = state(Behavior::HoldUntilCancel);
        let _ = send(
            &st,
            put(serde_json::json!({
                "revision": 0, "publicHost": "dev1", "requestedRunning": true, "relay": relay_json(),
            })),
        )
        .await;
        // a second writer still on revision 0 loses
        let (status, body) = send(
            &st,
            put(serde_json::json!({ "revision": 0, "publicHost": "evil", "requestedRunning": false })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["revision"], serde_json::json!(1), "current revision");
        assert_eq!(body["publicHost"], serde_json::json!("dev1"), "unchanged");
    }

    #[tokio::test]
    async fn requested_on_without_relay_reports_not_configured() {
        let (st, _started) = state(Behavior::HoldUntilCancel);
        let (_status, body) = send(
            &st,
            put(serde_json::json!({
                "revision": 0, "publicHost": "dev1.example.com", "requestedRunning": true,
            })),
        )
        .await;
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
        let (st, mut started) = state(Behavior::FailImmediately);
        let mut observed = st.daemon.watch_observed();
        let _ = send(
            &st,
            put(serde_json::json!({
                "revision": 0, "publicHost": "dev1.example.com",
                "requestedRunning": true, "relay": relay_json(),
            })),
        )
        .await;

        // the supervisor's attempt fails and the error surfaces (deterministic
        // await on the observed-state transition)
        observed
            .wait_for(|o| !o.running && o.error.as_deref() == Some("relay unreachable"))
            .await
            .expect("error observed");
        // and it keeps reconnecting — at least two attempts happen
        started.recv().await.expect("attempt 1");
        started.recv().await.expect("attempt 2");
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
            .oneshot(put(
                serde_json::json!({ "revision": 0, "requestedRunning": false }),
            ))
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
            put(serde_json::json!({
                "revision": 0,
                "publicHost": "dev1.example.com",
                "requestedRunning": true,
                "relay": relay_json(),
            })),
        )
        .await;
        let (status, body) = send(
            &st,
            put(serde_json::json!({
                "revision": 1,
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
            put(serde_json::json!({
                "revision": 0, "publicHost": "dev1.example.com",
                "requestedRunning": true, "relay": relay_json(),
            })),
        )
        .await;
        let (_status, body) = send(
            &st,
            put(serde_json::json!({ "revision": 1, "publicHost": "dev1.example.com", "requestedRunning": false })),
        )
        .await;
        assert_eq!(body["revision"], serde_json::json!(2));
        assert_eq!(body["running"], serde_json::json!(false));
        assert_eq!(
            body["servedOrigin"],
            serde_json::json!("http://127.0.0.1:8080")
        );
    }
}
