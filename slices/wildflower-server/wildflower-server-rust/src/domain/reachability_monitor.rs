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
//! ```text
//!   spawn ─ nothing published ─► probe after 400 ms
//!
//!   probe answered          ──► Reachable(report)        stop
//!   probe failed / no answer
//!     within 3 s            ──► Unreachable { error }    next probe in 400 ms
//! ```
//!
//! An unreachable verdict is published only when its reason changes.

use std::sync::Arc;
use std::time::Duration;

use shared_structures_rust::health_check::HealthReport;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use url::Url;

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
/// settle), and between probes until the server is reachable. Short, so the
/// first verdict and the first reach surface quickly.
const PROBE_INTERVAL: Duration = Duration::from_millis(400);

/// How long one probe may take before it counts as unreachable.
pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// The running monitor: the token that stops it when it is dropped.
pub(crate) struct ReachabilityMonitor {
    cancel: CancellationToken,
}

impl ReachabilityMonitor {
    /// Start probing `health_url` with `probe`, publishing each answer on
    /// `server_health_tx`. Spawns onto the ambient tokio runtime, and
    /// probes until `/health` answers or the monitor is dropped.
    pub(crate) fn spawn(
        probe: Arc<dyn HealthProbe>,
        health_url: Url,
        server_health_tx: watch::Sender<Option<ServerHealth>>,
    ) -> Self {
        let cancel = CancellationToken::new();
        tokio::spawn(monitor(probe, health_url, server_health_tx, cancel.clone()));
        Self { cancel }
    }
}

impl Drop for ReachabilityMonitor {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

/// Probe `health_url` every [`PROBE_INTERVAL`] until it answers or the monitor
/// is cancelled. Sleeping after each probe, rather than ticking at a fixed
/// period, means a slow probe never bursts catch-up probes.
async fn monitor(
    probe: Arc<dyn HealthProbe>,
    health_url: Url,
    server_health_tx: watch::Sender<Option<ServerHealth>>,
    cancel: CancellationToken,
) {
    loop {
        tokio::select! {
            () = tokio::time::sleep(PROBE_INTERVAL) => {}
            () = cancel.cancelled() => return,
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

    use shared_structures_rust::health_check::HealthStatus;
    use tokio::time::Instant;

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

    fn spawn(
        probe: Arc<ScriptedProbe>,
    ) -> (ReachabilityMonitor, watch::Receiver<Option<ServerHealth>>) {
        let (server_health_tx, server_health_rx) = watch::channel(None);
        let monitor = ReachabilityMonitor::spawn(probe, health_url(), server_health_tx);
        (monitor, server_health_rx)
    }

    #[tokio::test(start_paused = true)]
    async fn nothing_is_published_before_the_first_probe() {
        let probe = ScriptedProbe::new([Answer::Report(HealthReport::pass())]);
        let (_monitor, server_health_rx) = spawn(Arc::clone(&probe));
        tokio::time::sleep(Duration::from_millis(399)).await;
        assert_eq!(*server_health_rx.borrow(), None);
        assert!(probe.probe_times().is_empty());
    }

    /// Unreachable while the probe fails, re-probed every 400 ms; reachable
    /// once it answers, and then never probed again.
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
                Duration::from_millis(800),
                Duration::from_millis(1200),
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

        // Past the second probe (at 800 ms), short of the third (at 1200 ms).
        tokio::time::sleep(Duration::from_millis(500)).await;
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
