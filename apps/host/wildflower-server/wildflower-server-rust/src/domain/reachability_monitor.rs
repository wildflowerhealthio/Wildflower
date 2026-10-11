//! The reachability monitor: asks the server's own `/health` through its public
//! origin until it answers once, and publishes each answer as [`ServerHealth`].
//!
//! The request leaves the device, reaches the relay, and comes back down the
//! tunnel to the server, so an answer proves the whole round trip a remote app
//! makes. Once it has, the monitor stops: every app already reaches the server
//! through the same relay, so a steady poll would only add traffic. The
//! monitor is spawned once per server run, so the next run confirms reach
//! again. It also stops when the [`ReachabilityMonitor`] is dropped, which
//! [`WildflowerServer`](crate::WildflowerServer) does when it stops serving.
//!
//! A probe goes out only while the tunnel daemon reports
//! [`TunnelState::Connected`]: until the tunnel is up, a probe can only fail,
//! and the tunnel's own state already says why.
//!
//! ```text
//!   spawn ─ nothing published ─► after 400 ms, probe once Connected
//!
//!   probe answered          ──► Reachable(report)        stop
//!   probe failed / no answer
//!     within 3 s            ──► Unreachable { error }    after twice the last wait,
//!                                                        up to 30 s, probe once
//!                                                        Connected
//! ```
//!
//! An unreachable verdict is published only when its reason changes.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use url::Url;
use wildflowerhealthio_shared_structures::health_check::HealthReport;
use wildflowerhealthio_tunnel::TunnelState;

use crate::domain::server_health::ServerHealth;

/// Requests a `/health` URL and decodes its health report.
///
/// Implementations need not impose an overall deadline: the monitor bounds
/// every probe with [`PROBE_TIMEOUT`].
#[async_trait::async_trait]
pub(crate) trait HealthProbe: Send + Sync {
    /// `GET health_url` and decode the report it answered with.
    ///
    /// # Errors
    ///
    /// When the request fails, or the answer isn't a health report.
    async fn probe(&self, health_url: &Url) -> anyhow::Result<HealthReport>;
}

/// How long to wait before the first probe (let the tunnel's handshake
/// settle). Short, so the first verdict and a quick reach surface quickly.
const FIRST_PROBE_DELAY: Duration = Duration::from_millis(400);

/// The longest wait between probes. Each failed probe doubles the wait up to
/// this, so a server that stays unreachable (its tunnel down, or refused by
/// the relay) isn't probed every second for as long as it runs.
const MAX_PROBE_DELAY: Duration = Duration::from_secs(30);

/// How long one probe may take before it counts as unreachable.
pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// The running monitor: the token that stops it when it is dropped.
pub(crate) struct ReachabilityMonitor {
    cancel: CancellationToken,
}

impl ReachabilityMonitor {
    /// Start probing `health_url` with `probe` while `tunnel_state_rx` reads
    /// [`TunnelState::Connected`], publishing each answer on
    /// `server_health_tx`. Spawns onto the ambient tokio runtime, and probes
    /// until `/health` answers, the tunnel daemon is gone, or the monitor is
    /// dropped.
    pub(crate) fn spawn(
        probe: Arc<dyn HealthProbe>,
        health_url: Url,
        tunnel_state_rx: watch::Receiver<Option<TunnelState>>,
        server_health_tx: watch::Sender<Option<ServerHealth>>,
    ) -> Self {
        let cancel = CancellationToken::new();
        tokio::spawn(monitor(
            probe,
            health_url,
            tunnel_state_rx,
            server_health_tx,
            cancel.clone(),
        ));
        Self { cancel }
    }
}

impl Drop for ReachabilityMonitor {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

/// Probe `health_url` until it answers or the monitor is cancelled. Each
/// probe waits [`FIRST_PROBE_DELAY`] the first time and twice the last wait
/// after that, up to [`MAX_PROBE_DELAY`], then for the tunnel to be
/// connected. Sleeping after each probe, rather than ticking at a
/// fixed period, means a slow probe never bursts catch-up probes.
async fn monitor(
    probe: Arc<dyn HealthProbe>,
    health_url: Url,
    mut tunnel_state_rx: watch::Receiver<Option<TunnelState>>,
    server_health_tx: watch::Sender<Option<ServerHealth>>,
    cancel: CancellationToken,
) {
    let mut delay = FIRST_PROBE_DELAY;
    loop {
        tokio::select! {
            () = tokio::time::sleep(delay) => {}
            () = cancel.cancelled() => return,
        }
        let connected = tokio::select! {
            connected = tunnel_state_rx.wait_for(|state| state == &Some(TunnelState::Connected)) => connected.is_ok(),
            () = cancel.cancelled() => return,
        };
        // The daemon dropped its sender: no tunnel will ever connect.
        if !connected {
            return;
        }
        let server_health = tokio::select! {
            server_health = probe_once(probe.as_ref(), &health_url) => server_health,
            () = cancel.cancelled() => return,
        };
        let reached = matches!(server_health, ServerHealth::Reachable(_));
        server_health_tx.send_if_modified(|published| {
            if published.as_ref() == Some(&server_health) {
                return false;
            }
            // The host logs this module at info, which hides each probe's
            // debug line, so a new reason for being unreachable is logged
            // here, once.
            if let ServerHealth::Unreachable { error } = &server_health {
                tracing::warn!(url = %health_url, %error, "reachability: /health not answering through the public origin");
            }
            *published = Some(server_health);
            true
        });
        if reached {
            tracing::info!(url = %health_url, "reachability: /health answered through the public origin");
            return;
        }
        delay = (delay * 2).min(MAX_PROBE_DELAY);
    }
}

/// One bounded probe: an answer is reachable; a failure or a timeout is
/// unreachable, with why.
async fn probe_once(probe: &dyn HealthProbe, health_url: &Url) -> ServerHealth {
    let server_health = match tokio::time::timeout(PROBE_TIMEOUT, probe.probe(health_url)).await {
        Ok(Ok(report)) => ServerHealth::Reachable(report),
        Ok(Err(error)) => ServerHealth::Unreachable {
            error: format!("{error:#}"),
        },
        Err(_elapsed) => ServerHealth::Unreachable {
            error: format!("/health did not answer within {PROBE_TIMEOUT:?}"),
        },
    };
    tracing::debug!(url = %health_url, ?server_health, "reachability: /health probed");
    server_health
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use tokio::time::Instant;
    use wildflowerhealthio_shared_structures::health_check::HealthStatus;

    use super::*;

    /// What one scripted probe does.
    #[derive(Clone)]
    enum Answer {
        Report(HealthReport),
        Refused,
        Hang,
    }

    /// A probe that plays a script, one answer per probe, then repeats the
    /// last; it records the URL and the (virtual) time of every probe.
    struct ScriptedProbe {
        script: Mutex<VecDeque<Answer>>,
        probes: Mutex<Vec<(Url, Instant)>>,
    }

    impl ScriptedProbe {
        fn new(script: impl IntoIterator<Item = Answer>) -> Arc<Self> {
            Arc::new(Self {
                script: Mutex::new(script.into_iter().collect()),
                probes: Mutex::new(Vec::new()),
            })
        }

        fn probe_times(&self) -> Vec<Instant> {
            self.probes
                .lock()
                .expect("probes lock")
                .iter()
                .map(|(_, at)| *at)
                .collect()
        }
    }

    #[async_trait::async_trait]
    impl HealthProbe for ScriptedProbe {
        async fn probe(&self, health_url: &Url) -> anyhow::Result<HealthReport> {
            self.probes
                .lock()
                .expect("probes lock")
                .push((health_url.clone(), Instant::now()));
            let answer = {
                let mut script = self.script.lock().expect("script lock");
                if script.len() > 1 {
                    script.pop_front()
                } else {
                    script.front().cloned()
                }
            };
            match answer.expect("a scripted answer") {
                Answer::Report(report) => Ok(report),
                Answer::Refused => Err(anyhow::anyhow!("connection refused")),
                Answer::Hang => std::future::pending().await,
            }
        }
    }

    fn health_url() -> Url {
        Url::parse("https://ruth.relay.example/health").expect("health URL")
    }

    fn failing_report() -> HealthReport {
        HealthReport {
            status: HealthStatus::Fail,
            ..HealthReport::pass()
        }
    }

    /// Spawn the monitor over a tunnel that is already connected. The
    /// sender can go: the monitor reads the last state it published.
    fn spawn(
        probe: Arc<ScriptedProbe>,
    ) -> (ReachabilityMonitor, watch::Receiver<Option<ServerHealth>>) {
        let (_tunnel_state_tx, tunnel_state_rx) = watch::channel(Some(TunnelState::Connected));
        spawn_over(probe, tunnel_state_rx)
    }

    fn spawn_over(
        probe: Arc<ScriptedProbe>,
        tunnel_state_rx: watch::Receiver<Option<TunnelState>>,
    ) -> (ReachabilityMonitor, watch::Receiver<Option<ServerHealth>>) {
        let (server_health_tx, server_health_rx) = watch::channel(None);
        let monitor =
            ReachabilityMonitor::spawn(probe, health_url(), tunnel_state_rx, server_health_tx);
        (monitor, server_health_rx)
    }

    /// No probe goes out until the tunnel connects; the first follows as soon
    /// as it does.
    #[tokio::test(start_paused = true)]
    async fn waits_for_the_tunnel_to_connect_before_probing() {
        let probe = ScriptedProbe::new([Answer::Report(HealthReport::pass())]);
        let (tunnel_state_tx, tunnel_state_rx) = watch::channel(Some(TunnelState::Connecting));
        let (_monitor, mut server_health_rx) = spawn_over(Arc::clone(&probe), tunnel_state_rx);

        tunnel_state_tx.send_replace(Some(TunnelState::Reconnecting {
            error: "dns error".to_owned(),
        }));
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert!(probe.probe_times().is_empty(), "no probe before Connected");

        let connected_at = Instant::now();
        tunnel_state_tx.send_replace(Some(TunnelState::Connected));
        server_health_rx
            .wait_for(Option::is_some)
            .await
            .expect("published");
        assert_eq!(probe.probe_times(), [connected_at]);
    }

    /// A probe that fails while the tunnel drops waits for it to reconnect
    /// before probing again.
    #[tokio::test(start_paused = true)]
    async fn a_dropped_tunnel_pauses_probing() {
        let probe = ScriptedProbe::new([Answer::Refused]);
        let (tunnel_state_tx, tunnel_state_rx) = watch::channel(Some(TunnelState::Connected));
        let (_monitor, mut server_health_rx) = spawn_over(Arc::clone(&probe), tunnel_state_rx);
        server_health_rx
            .wait_for(Option::is_some)
            .await
            .expect("published");

        tunnel_state_tx.send_replace(Some(TunnelState::Reconnecting {
            error: "connection reset".to_owned(),
        }));
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert_eq!(probe.probe_times().len(), 1, "no probe while reconnecting");
    }

    /// A tunnel the relay refused never connects, so it is never probed; and
    /// once the daemon is gone, neither is anything else.
    #[tokio::test(start_paused = true)]
    async fn a_refused_tunnel_is_never_probed() {
        let probe = ScriptedProbe::new([Answer::Report(HealthReport::pass())]);
        let (tunnel_state_tx, tunnel_state_rx) = watch::channel(Some(TunnelState::TokenRejected));
        let (_monitor, server_health_rx) = spawn_over(Arc::clone(&probe), tunnel_state_rx);
        tokio::time::sleep(Duration::from_secs(60)).await;
        drop(tunnel_state_tx);
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert!(probe.probe_times().is_empty());
        assert_eq!(*server_health_rx.borrow(), None);
    }

    #[tokio::test(start_paused = true)]
    async fn nothing_is_published_before_the_first_probe() {
        let probe = ScriptedProbe::new([Answer::Report(HealthReport::pass())]);
        let (_monitor, server_health_rx) = spawn(Arc::clone(&probe));
        tokio::time::sleep(Duration::from_millis(399)).await;
        assert_eq!(*server_health_rx.borrow(), None);
        assert!(probe.probe_times().is_empty());
    }

    /// Unreachable while the probe fails, re-probed after 400 ms, 800 ms,
    /// 1.6 s, …; reachable once it answers, and then never probed again.
    #[tokio::test(start_paused = true)]
    async fn goes_from_unreachable_to_reachable_and_stops() {
        let started = Instant::now();
        let probe = ScriptedProbe::new([
            Answer::Refused,
            Answer::Refused,
            Answer::Report(HealthReport::pass()),
        ]);
        let (_monitor, mut server_health_rx) = spawn(Arc::clone(&probe));

        let unreachable = server_health_rx
            .wait_for(Option::is_some)
            .await
            .expect("published")
            .clone();
        assert_eq!(
            unreachable,
            Some(ServerHealth::Unreachable {
                error: "connection refused".to_owned()
            })
        );
        server_health_rx
            .wait_for(|health| health == &Some(ServerHealth::Reachable(HealthReport::pass())))
            .await
            .expect("reachable");
        tokio::time::sleep(Duration::from_secs(60)).await;

        let offsets: Vec<Duration> = probe
            .probe_times()
            .into_iter()
            .map(|at| at - started)
            .collect();
        assert_eq!(
            offsets,
            [
                Duration::from_millis(400),
                Duration::from_millis(1200),
                Duration::from_millis(2800),
            ],
            "no probe follows the first answer"
        );
        assert!(
            probe
                .probes
                .lock()
                .expect("probes lock")
                .iter()
                .all(|(url, _)| *url == health_url()),
            "every probe asks the server's /health through its public origin"
        );
    }

    /// A server that stays unreachable is probed less and less often, never
    /// more than 30 s apart.
    #[tokio::test(start_paused = true)]
    async fn an_unreachable_server_is_probed_with_backoff() {
        let probe = ScriptedProbe::new([Answer::Refused]);
        let (_monitor, _server_health_rx) = spawn(Arc::clone(&probe));
        tokio::time::sleep(Duration::from_secs(120)).await;

        let gaps: Vec<Duration> = probe
            .probe_times()
            .windows(2)
            .map(|pair| pair[1] - pair[0])
            .collect();
        assert_eq!(
            gaps,
            [800, 1600, 3200, 6400, 12800, 25600, 30000, 30000].map(Duration::from_millis),
        );
    }

    /// A server that answers `fail` is reachable: it answered.
    #[tokio::test(start_paused = true)]
    async fn a_failing_report_is_still_reachable() {
        let probe = ScriptedProbe::new([Answer::Report(failing_report())]);
        let (_monitor, mut server_health_rx) = spawn(Arc::clone(&probe));
        let reached = server_health_rx
            .wait_for(Option::is_some)
            .await
            .expect("published")
            .clone();
        assert_eq!(reached, Some(ServerHealth::Reachable(failing_report())));
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert_eq!(probe.probe_times().len(), 1, "an answer ends the probing");
    }

    /// Repeated failures for the same reason are published once; a new reason
    /// is published again.
    #[tokio::test(start_paused = true)]
    async fn only_a_changed_unreachable_reason_is_republished() {
        let probe = ScriptedProbe::new([Answer::Refused, Answer::Refused, Answer::Hang]);
        let (_monitor, mut server_health_rx) = spawn(Arc::clone(&probe));
        server_health_rx
            .wait_for(Option::is_some)
            .await
            .expect("published");
        server_health_rx.borrow_and_update();

        // Past the second probe (at 1200 ms), short of the third (at 2800 ms).
        tokio::time::sleep(Duration::from_millis(1000)).await;
        assert_eq!(probe.probe_times().len(), 2);
        assert!(
            !server_health_rx
                .has_changed()
                .expect("the monitor holds the sender"),
            "the same reason again is not a change"
        );

        let timed_out = server_health_rx
            .wait_for(|health| {
                health.as_ref()
                    != Some(&ServerHealth::Unreachable {
                        error: "connection refused".to_owned(),
                    })
            })
            .await
            .expect("republished")
            .clone();
        assert_eq!(
            timed_out,
            Some(ServerHealth::Unreachable {
                error: "/health did not answer within 3s".to_owned()
            })
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_probe_that_never_answers_is_unreachable_after_the_timeout() {
        let started = Instant::now();
        let probe = ScriptedProbe::new([Answer::Hang]);
        let (_monitor, mut server_health_rx) = spawn(probe);
        let unreachable = server_health_rx
            .wait_for(Option::is_some)
            .await
            .expect("published")
            .clone();
        assert_eq!(
            unreachable,
            Some(ServerHealth::Unreachable {
                error: "/health did not answer within 3s".to_owned()
            })
        );
        assert_eq!(Instant::now() - started, Duration::from_millis(3400));
    }

    #[tokio::test(start_paused = true)]
    async fn dropping_the_monitor_stops_probing() {
        let probe = ScriptedProbe::new([Answer::Refused]);
        let (monitor, mut server_health_rx) = spawn(Arc::clone(&probe));
        server_health_rx
            .wait_for(Option::is_some)
            .await
            .expect("published");
        drop(monitor);
        let probes_at_drop = probe.probe_times().len();
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert_eq!(probe.probe_times().len(), probes_at_drop);
    }
}
