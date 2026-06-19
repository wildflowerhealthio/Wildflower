//! Programmatic tunnel control — the in-process seam the apps slice (and any
//! other host-side consumer) drives instead of issuing an HTTP `PUT /tunnel`.
//!
//! Two channels make up the seam:
//!
//!  - a **trigger** channel ([`TunnelControl::request_start`]) — an `mpsc` of
//!    one-shot reply senders. A resident task owns the [`TunnelState`] and runs
//!    the same persist-then-reconcile a `PUT` would, then reports the resolved
//!    public origin (or a human-readable failure) back on the one-shot. This is
//!    what backs the `AppsBridge` `RequestTunnel` → `TunnelStarted`/`TunnelFailed`
//!    round-trip the embedded SPA already speaks.
//!  - a **served-origin** channel ([`TunnelControl::watch_served_origin`]) — a
//!    clone of the daemon's `watch` of the live served origin
//!    (`https://{publicHost}` while dialing, else the loopback fallback), so a
//!    consumer can read the current public URL without a round-trip. The apps
//!    launch handler reads this to resolve `requires_tunnel` launches.

use std::sync::Arc;

use tokio::sync::{mpsc, oneshot, watch};

use crate::db::{SettingsUpdate, SettingsUpdateOutcome};
use crate::http::TunnelState;

/// How many bounded start requests can queue before `request_start` awaits a
/// free slot. Starts are cheap and rare (a user launching a tunnel app), so a
/// small buffer is plenty; the bound just stops an unbounded backlog if the
/// resident task ever stalls.
const START_QUEUE_DEPTH: usize = 16;

/// A handle onto the running tunnel's control seam. Cheap to clone (an `mpsc`
/// sender plus a `watch` receiver); hand a clone to each consumer.
#[derive(Clone)]
pub struct TunnelControl {
    start_tx: mpsc::Sender<oneshot::Sender<Result<String, String>>>,
    served_origin_rx: watch::Receiver<String>,
}

impl TunnelControl {
    /// Request the tunnel turn on, awaiting the outcome. `Ok(origin)` carries
    /// the live public `https://{publicHost}`; `Err(reason)` is a
    /// human-readable failure (relay unconfigured, no public host, or
    /// persistence contention) suitable for surfacing inline. Mirrors the
    /// `PUT /tunnel` happy path but without an HTTP hop — the optimistic
    /// `running`/`servedOrigin` caveats from [`crate::http`] apply.
    pub async fn request_start(&self) -> Result<String, String> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.start_tx
            .send(reply_tx)
            .await
            .map_err(|_| "tunnel control task is no longer running".to_string())?;
        reply_rx
            .await
            .map_err(|_| "tunnel control task dropped the start request".to_string())?
    }

    /// The current served origin (`https://{publicHost}` while the tunnel is
    /// dialing a configured host, else the loopback fallback).
    pub fn served_origin(&self) -> String {
        self.served_origin_rx.borrow().clone()
    }

    /// A fresh subscription to served-origin changes for consumers that want to
    /// react to transitions (the apps launch handler holds one of these).
    pub fn watch_served_origin(&self) -> watch::Receiver<String> {
        self.served_origin_rx.clone()
    }
}

/// Spawn the resident control task over the shared `state` and return a
/// [`TunnelControl`] handle. The task lives until every `TunnelControl` clone
/// is dropped (the `mpsc` sender closes), which for the host is process
/// lifetime.
pub(crate) fn spawn_control(state: Arc<TunnelState>) -> TunnelControl {
    let (start_tx, mut start_rx) =
        mpsc::channel::<oneshot::Sender<Result<String, String>>>(START_QUEUE_DEPTH);
    let served_origin_rx = state.daemon.watch_served_origin();

    tokio::spawn(async move {
        while let Some(reply) = start_rx.recv().await {
            let outcome = start_tunnel(&state);
            // A dropped receiver means the requester superseded or timed out;
            // the persisted intent still stands, so nothing to undo.
            let _ = reply.send(outcome);
        }
    });

    TunnelControl {
        start_tx,
        served_origin_rx,
    }
}

/// Persist `requested_running = true` and reconcile, then resolve the outcome.
/// Runs the same compare-and-swap the `PUT` handler does, retrying a bounded
/// number of times if a racing write bumps the revision between our read and
/// write.
fn start_tunnel(state: &TunnelState) -> Result<String, String> {
    for _ in 0..START_QUEUE_DEPTH {
        let current = state
            .store
            .get_settings()
            .map_err(|e| format!("failed to read tunnel settings: {e}"))?;

        if current.requested_running {
            // Already requested on — make the daemon reflect the persisted
            // intent (a no-op when it's already the live revision) and report.
            state.daemon.reconcile(&current);
            return resolve_start_outcome(state);
        }

        let outcome = state
            .store
            .replace_settings(
                current.revision,
                SettingsUpdate {
                    public_host: current.public_host.clone(),
                    requested_running: true,
                    // Keep the stored relay connection — start never edits it.
                    relay_settings: None,
                },
            )
            .map_err(|e| format!("failed to persist tunnel start: {e}"))?;

        if let SettingsUpdateOutcome::Applied(settings) = outcome {
            state.daemon.reconcile(&settings);
            return resolve_start_outcome(state);
        }
        // Conflict: a racing write moved the revision — re-read and retry.
    }
    Err("tunnel settings changed under concurrent writes; please retry".to_string())
}

/// Read the daemon's observed state after a start and turn it into the
/// caller-facing result: an error if the daemon reports one, the public origin
/// when a tunnel is up, or a "no public host" error when the tunnel is dialing
/// but has nowhere public to be reached.
fn resolve_start_outcome(state: &TunnelState) -> Result<String, String> {
    if let Some(error) = state.daemon.observed().error {
        return Err(error);
    }
    let origin = state.daemon.served_origin();
    if origin.starts_with("https://") {
        Ok(origin)
    } else {
        Err("tunnel is running but no public host is configured".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::TunnelStore;
    use crate::domain::{RelayClient, RelaySettings, TunnelDaemon};
    use tokio_util::sync::CancellationToken;

    /// A relay client that "succeeds" immediately without dialing — the start
    /// path reads the daemon's *optimistic* observed state synchronously right
    /// after reconcile, so the supervisor this spawns never races the
    /// assertion.
    struct NoopRelayClient;

    #[async_trait::async_trait]
    impl RelayClient for NoopRelayClient {
        async fn run_once(
            &self,
            _relay: &RelaySettings,
            _local_addr: &str,
            _cancel: CancellationToken,
        ) -> anyhow::Result<()> {
            Ok(())
        }
    }

    fn relay() -> RelaySettings {
        RelaySettings {
            remote_addr: "relay.example.com:2333".into(),
            token: "tok".into(),
            public_key: "key".into(),
            service_name: "dev1".into(),
        }
    }

    /// A resumed `TunnelState` with `public_host`/`relay` configured (the tunnel
    /// not yet requested on), mirroring `setup_tunnel`'s post-seed resume.
    fn resumed_state(
        public_host: Option<&str>,
        relay_settings: Option<RelaySettings>,
    ) -> Arc<TunnelState> {
        let store = TunnelStore::open_in_memory().expect("open in-memory store");
        store
            .replace_settings(
                0,
                SettingsUpdate {
                    public_host: public_host.map(str::to_owned),
                    requested_running: false,
                    relay_settings,
                },
            )
            .expect("seed settings");
        let daemon =
            TunnelDaemon::new_test(Arc::new(NoopRelayClient), "http://127.0.0.1:8080", 8080);
        daemon.reconcile(&store.get_settings().expect("read settings"));
        Arc::new(TunnelState { store, daemon })
    }

    #[tokio::test]
    async fn request_start_turns_on_and_returns_the_public_origin() {
        let control = spawn_control(resumed_state(Some("dev1.example.com"), Some(relay())));
        // The optimistic public origin is resolved synchronously inside the
        // start (before the spawned supervisor runs), so the return is
        // deterministic even though a real relay session's later transitions
        // are not.
        assert_eq!(
            control.request_start().await,
            Ok("https://dev1.example.com".to_string())
        );
    }

    #[tokio::test]
    async fn request_start_without_a_relay_reports_not_configured() {
        let control = spawn_control(resumed_state(Some("dev1.example.com"), None));
        assert_eq!(
            control.request_start().await,
            Err("tunnel relay is not configured".to_string())
        );
    }

    #[tokio::test]
    async fn request_start_with_relay_but_no_public_host_errs() {
        let control = spawn_control(resumed_state(None, Some(relay())));
        assert_eq!(
            control.request_start().await,
            Err("tunnel is running but no public host is configured".to_string())
        );
    }
}
