//! The `/tunnel` GET/PUT handlers and wire types.
//!
//! NOTE(pr-ui): this Rust surface is the new tunnel contract — a full-replace
//! PUT with an optimistic-concurrency `revision`, a single `publicHost`, and a
//! write-only `relay` block. The `tunnel-core` TS schema and the `tunnel-react`
//! UI still speak the old PATCH/`subdomain`/`rootDomain` shape and are
//! reconciled in the follow-up UI PR; they are intentionally out of sync until
//! then.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::db::{ReplaceOutcome, SettingsUpdate};
use crate::domain::{RelayConnection, TunnelSettings};
use crate::http::state::TunnelState;

/// Tunnel state on the wire. Relay connection details are write-only and never
/// appear here. `revision` is the optimistic-concurrency token a PUT must echo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStateWire {
    revision: i64,
    public_host: Option<String>,
    requested_running: bool,
    running: bool,
    error: Option<String>,
    served_origin: String,
}

/// PUT body — a full replace of the visible settings guarded by `revision`,
/// plus an optional write-only `relay` block (absent = keep the stored relay
/// connection, present = replace all four fields).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceTunnelRequestBody {
    revision: i64,
    #[serde(default)]
    public_host: Option<String>,
    requested_running: bool,
    #[serde(default)]
    relay: Option<RelayInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayInput {
    remote_addr: String,
    token: String,
    public_key: String,
    service_name: String,
}

impl From<RelayInput> for RelayConnection {
    fn from(input: RelayInput) -> Self {
        RelayConnection {
            remote_addr: input.remote_addr,
            token: input.token,
            public_key: input.public_key,
            service_name: input.service_name,
        }
    }
}

/// Compute the origin clients should reach the server at: the public
/// `https://{publicHost}` only when the tunnel is up and the host is set, else
/// the loopback fallback.
fn served_origin(running: bool, public_host: Option<&str>, loopback_origin: &str) -> String {
    match public_host {
        Some(host) if running && !host.is_empty() => format!("https://{host}"),
        _ => loopback_origin.to_string(),
    }
}

impl TunnelState {
    /// Build the wire snapshot from persisted `settings` + the live observed
    /// runtime.
    pub(crate) fn snapshot(&self, settings: &TunnelSettings) -> TunnelStateWire {
        let observed = self.observed();
        let served_origin = served_origin(
            observed.running,
            settings.public_host.as_deref(),
            self.loopback_origin(),
        );
        TunnelStateWire {
            revision: settings.revision,
            public_host: settings.public_host.clone(),
            requested_running: settings.requested_running,
            running: observed.running,
            error: observed.error,
            served_origin,
        }
    }
}

/// Build the `/tunnel` router (GET + PUT) over a [`TunnelState`].
pub fn tunnel_router(state: Arc<TunnelState>) -> Router {
    Router::new()
        .route("/tunnel", get(get_tunnel).put(put_tunnel))
        .with_state(state)
}

async fn get_tunnel(
    State(state): State<Arc<TunnelState>>,
) -> Result<Json<TunnelStateWire>, StatusCode> {
    let settings = state
        .store
        .get_settings()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(state.snapshot(&settings)))
}

async fn put_tunnel(
    State(state): State<Arc<TunnelState>>,
    Json(body): Json<ReplaceTunnelRequestBody>,
) -> Response {
    let update = SettingsUpdate {
        public_host: body.public_host,
        requested_running: body.requested_running,
        relay: body.relay.map(RelayConnection::from),
    };
    match state.store.replace_settings(body.revision, update) {
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        Ok(ReplaceOutcome::Applied(settings)) => {
            state.reconcile(&settings);
            Json(state.snapshot(&settings)).into_response()
        }
        Ok(ReplaceOutcome::Conflict(current)) => {
            (StatusCode::CONFLICT, Json(state.snapshot(&current))).into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tokio::sync::mpsc;
    use tower::ServiceExt;

    use super::*;
    use crate::client::RelayClient;
    use crate::db::TunnelStore;
    use tokio_util::sync::CancellationToken;

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
            _relay: &RelayConnection,
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
        let state = Arc::new(TunnelState::new_test(
            store,
            client,
            "http://127.0.0.1:8080",
            8080,
        ));
        (state, rx)
    }

    async fn send(state: &Arc<TunnelState>, req: Request<Body>) -> (StatusCode, serde_json::Value) {
        let res = tunnel_router(Arc::clone(state))
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
        let mut observed = st.watch_observed();
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
