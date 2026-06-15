//! The `/tunnel` GET/PATCH handlers and wire types.
//!
//! Wire shapes are pinned to the TS schemas in
//! `slices/tunnel/tunnel-core/src/http-api-definition/tunnel.ts`
//! (`TunnelStateSchema`, `SetTunnelRequestBodySchema`). The golden test guards
//! against drift.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Deserializer, Serialize};

use crate::db::SettingsPatch;
use crate::domain::TunnelSettings;
use crate::http::state::TunnelState;

/// Merged tunnel state on the wire — matches `TunnelStateSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStateWire {
    subdomain: Option<String>,
    root_domain: Option<String>,
    requested_running: bool,
    running: bool,
    current_subdomain: Option<String>,
    current_root_domain: Option<String>,
    current_local_port: Option<u16>,
    error: Option<String>,
    served_origin: String,
}

/// PATCH body — config-side fields only, matching `SetTunnelRequestBodySchema`.
/// `subdomain`/`rootDomain` use double-`Option` so the three TS cases survive
/// the wire: key absent (`None`) preserves, explicit `null` (`Some(None)`)
/// clears, a value (`Some(Some(_))`) sets.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetTunnelRequestBody {
    #[serde(default, deserialize_with = "double_option")]
    subdomain: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    root_domain: Option<Option<String>>,
    #[serde(default)]
    requested_running: Option<bool>,
}

impl SetTunnelRequestBody {
    fn touches_running(&self) -> bool {
        self.requested_running.is_some()
    }

    fn into_patch(self) -> SettingsPatch {
        SettingsPatch {
            subdomain: self.subdomain,
            root_domain: self.root_domain,
            requested_running: self.requested_running,
        }
    }
}

fn double_option<'de, D, T>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::<T>::deserialize(de)?))
}

/// Compute the origin clients should reach the server at, mirroring
/// `served-origin.ts`: the public `https://{sub}.{root}` only when the tunnel
/// is up and both labels are present and non-empty, else the loopback fallback.
fn served_origin(
    running: bool,
    current_subdomain: Option<&str>,
    current_root_domain: Option<&str>,
    loopback_origin: &str,
) -> String {
    match (running, current_subdomain, current_root_domain) {
        (true, Some(sub), Some(root)) if !sub.is_empty() && !root.is_empty() => {
            format!("https://{sub}.{root}")
        }
        _ => loopback_origin.to_string(),
    }
}

impl TunnelState {
    /// Build the wire snapshot from persisted `settings` + the live runtime.
    pub(crate) fn snapshot(&self, settings: &TunnelSettings) -> TunnelStateWire {
        let runtime = self.runtime_view();
        let origin = served_origin(
            runtime.running,
            runtime.current_subdomain.as_deref(),
            runtime.current_root_domain.as_deref(),
            self.loopback_origin(),
        );
        TunnelStateWire {
            subdomain: settings.subdomain.clone(),
            root_domain: settings.root_domain.clone(),
            requested_running: settings.requested_running,
            running: runtime.running,
            current_subdomain: runtime.current_subdomain,
            current_root_domain: runtime.current_root_domain,
            current_local_port: runtime.current_local_port,
            error: runtime.error,
            served_origin: origin,
        }
    }
}

/// Build the `/tunnel` router (GET + PATCH) over a [`TunnelState`].
pub fn tunnel_router(state: Arc<TunnelState>) -> Router {
    Router::new()
        .route("/tunnel", get(get_tunnel).patch(patch_tunnel))
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

async fn patch_tunnel(
    State(state): State<Arc<TunnelState>>,
    Json(body): Json<SetTunnelRequestBody>,
) -> Result<Json<TunnelStateWire>, StatusCode> {
    let touched_running = body.touches_running();
    let settings = state
        .store
        .patch_settings(body.into_patch())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if touched_running {
        state.apply_running(&settings);
    }
    Ok(Json(state.snapshot(&settings)))
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use parking_lot::Mutex as PlMutex;
    use tower::ServiceExt;

    use super::*;
    use crate::client::{ExitReporter, RelayClient, RelayHandle, TunnelStatus};
    use crate::db::TunnelStore;

    /// Fake client: records start/stop and either succeeds or fails on start,
    /// so the handler state machine is testable without a live relay. On a
    /// successful start it retains the [`ExitReporter`] so a test can simulate
    /// a *post-launch* exit deterministically via [`Self::fail_after_launch`].
    struct FakeClient {
        succeed: bool,
        starts: PlMutex<u32>,
        last_reporter: PlMutex<Option<ExitReporter>>,
    }

    impl FakeClient {
        fn ok() -> Arc<Self> {
            Arc::new(Self {
                succeed: true,
                starts: PlMutex::new(0),
                last_reporter: PlMutex::new(None),
            })
        }
        fn failing() -> Arc<Self> {
            Arc::new(Self {
                succeed: false,
                starts: PlMutex::new(0),
                last_reporter: PlMutex::new(None),
            })
        }

        /// Fire the most recent start's exit reporter with a post-launch
        /// failure, as the embedded rathole task would on a relay drop.
        fn fail_after_launch(&self, message: &str) {
            if let Some(reporter) = self.last_reporter.lock().take() {
                reporter.report(TunnelStatus::Failed(message.to_string()));
            }
        }
    }

    impl RelayClient for FakeClient {
        fn start(
            &self,
            _: &TunnelSettings,
            _: &str,
            on_exit: ExitReporter,
        ) -> anyhow::Result<RelayHandle> {
            *self.starts.lock() += 1;
            if self.succeed {
                *self.last_reporter.lock() = Some(on_exit);
                Ok(RelayHandle::test_handle())
            } else {
                Err(anyhow::anyhow!("relay unreachable"))
            }
        }
    }

    fn state(client: Arc<dyn RelayClient>) -> Arc<TunnelState> {
        let store = TunnelStore::open_in_memory().expect("store");
        Arc::new(TunnelState::new(
            store,
            client,
            "http://127.0.0.1:8080",
            8080,
        ))
    }

    async fn send(state: Arc<TunnelState>, req: Request<Body>) -> serde_json::Value {
        let res = tunnel_router(state).oneshot(req).await.expect("oneshot");
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = res.into_body().collect().await.expect("body").to_bytes();
        serde_json::from_slice(&bytes).expect("json")
    }

    fn get() -> Request<Body> {
        Request::builder()
            .uri("/tunnel")
            .body(Body::empty())
            .unwrap()
    }

    fn patch(json: serde_json::Value) -> Request<Body> {
        Request::builder()
            .method("PATCH")
            .uri("/tunnel")
            .header("content-type", "application/json")
            .body(Body::from(json.to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn empty_state_is_the_schema_shaped_default() {
        let body = send(state(FakeClient::ok()), get()).await;
        assert_eq!(
            body,
            serde_json::json!({
                "subdomain": null,
                "rootDomain": null,
                "requestedRunning": false,
                "running": false,
                "currentSubdomain": null,
                "currentRootDomain": null,
                "currentLocalPort": null,
                "error": null,
                "servedOrigin": "http://127.0.0.1:8080",
            })
        );
    }

    #[tokio::test]
    async fn requesting_running_with_provisioned_subdomain_reports_public_origin() {
        let st = state(FakeClient::ok());
        // provision subdomain/root first, then turn on
        let _ = send(
            st.clone(),
            patch(serde_json::json!({ "subdomain": "dev1", "rootDomain": "example.com" })),
        )
        .await;
        let body = send(st, patch(serde_json::json!({ "requestedRunning": true }))).await;
        assert_eq!(body["running"], serde_json::json!(true));
        assert_eq!(body["currentSubdomain"], serde_json::json!("dev1"));
        assert_eq!(body["currentLocalPort"], serde_json::json!(8080));
        assert_eq!(
            body["servedOrigin"],
            serde_json::json!("https://dev1.example.com")
        );
    }

    #[tokio::test]
    async fn a_failed_start_keeps_intent_but_records_error_and_stays_loopback() {
        let body = send(
            state(FakeClient::failing()),
            patch(serde_json::json!({ "requestedRunning": true })),
        )
        .await;
        assert_eq!(body["requestedRunning"], serde_json::json!(true));
        assert_eq!(body["running"], serde_json::json!(false));
        assert_eq!(body["error"], serde_json::json!("relay unreachable"));
        assert_eq!(
            body["servedOrigin"],
            serde_json::json!("http://127.0.0.1:8080")
        );
    }

    #[tokio::test]
    async fn a_post_launch_exit_flips_running_off_and_surfaces_the_error() {
        let client = FakeClient::ok();
        let st = state(client.clone());
        // provision + turn on in one request
        let body = send(
            st.clone(),
            patch(serde_json::json!({
                "subdomain": "dev1",
                "rootDomain": "example.com",
                "requestedRunning": true,
            })),
        )
        .await;
        assert_eq!(body["running"], serde_json::json!(true), "launched");

        // the relay drops after launch; the client task reports the failure
        client.fail_after_launch("relay dropped: handshake rejected");

        let body = send(st, get()).await;
        assert_eq!(
            body["requestedRunning"],
            serde_json::json!(true),
            "intent kept"
        );
        assert_eq!(body["running"], serde_json::json!(false));
        assert_eq!(
            body["error"],
            serde_json::json!("relay dropped: handshake rejected")
        );
        assert_eq!(body["currentSubdomain"], serde_json::json!(null));
        assert_eq!(
            body["servedOrigin"],
            serde_json::json!("http://127.0.0.1:8080"),
            "back to loopback once the tunnel is down"
        );
    }

    #[tokio::test]
    async fn a_superseded_tunnels_late_exit_is_ignored() {
        let client = FakeClient::ok();
        let st = state(client.clone());
        // start tunnel A
        let _ = send(
            st.clone(),
            patch(serde_json::json!({ "subdomain": "dev1", "requestedRunning": true })),
        )
        .await;
        // capture A's reporter, then restart (tunnel B) — bumps the generation
        let a_reporter = client.last_reporter.lock().take();
        let _ = send(
            st.clone(),
            patch(serde_json::json!({ "requestedRunning": true })),
        )
        .await;

        // A's late failure must not clobber B's live state
        if let Some(reporter) = a_reporter {
            reporter.report(TunnelStatus::Failed("stale A failure".into()));
        }
        let body = send(st, get()).await;
        assert_eq!(body["running"], serde_json::json!(true), "B still running");
        assert_eq!(
            body["error"],
            serde_json::json!(null),
            "stale error ignored"
        );
    }

    #[tokio::test]
    async fn intent_persists_across_requests() {
        let st = state(FakeClient::ok());
        let _ = send(
            st.clone(),
            patch(serde_json::json!({ "subdomain": "dev1" })),
        )
        .await;
        // a subsequent GET still shows the persisted subdomain
        let body = send(st, get()).await;
        assert_eq!(body["subdomain"], serde_json::json!("dev1"));
    }
}
