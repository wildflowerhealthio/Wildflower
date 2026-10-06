//! The reachability monitor: asks the server's own `/health` through its public
//! origin on a cadence, and publishes the answer as [`ServerHealth`].
//!
//! The request leaves the device, reaches the relay, and comes back down the
//! tunnel to the server, so an answer proves the whole round trip a remote app
//! makes. The monitor is spawned once per server run and stops when the
//! [`ReachabilityMonitor`] is dropped, which [`WildflowerServer`](crate::WildflowerServer)
//! does when it stops serving.
//!
//! ```text
//!   spawn ─ nothing published ─► probe after 400 ms
//!
//!   probe answered          ──► Reachable(report)        next probe in 30 s
//!   probe failed / no answer
//!     within 3 s            ──► Unreachable { error }    next probe in 400 ms
//! ```
//!
//! Only a change is published: a report whose statuses match the last one's
//! (its checks' `time`s aside), or the same unreachable reason, is not.

use std::sync::Arc;
use std::time::Duration;

use shared_structures_rust::health_check::{ComponentType, HealthReport, HealthStatus};
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
/// settle), and between probes while the server is not reachable. Short, so
/// the first verdict and a recovery surface quickly.
const PROBE_INTERVAL: Duration = Duration::from_millis(400);

/// How long to wait between probes once the server is reachable: a healthy
/// steady state only needs an occasional check, not a back-to-back `/health`
/// poll through the relay.
const REACHABLE_PROBE_INTERVAL: Duration = Duration::from_secs(30);

/// How long one probe may take before it counts as unreachable.
pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// The running monitor: the token that stops it when it is dropped.
pub(crate) struct ReachabilityMonitor {
    cancel: CancellationToken,
}

impl ReachabilityMonitor {
    /// Start probing `health_url` with `probe`, publishing each answer on
    /// `server_health_sender`. Spawns onto the ambient tokio runtime, and
    /// probes until the monitor is dropped.
    pub(crate) fn spawn(
        probe: Arc<dyn HealthProbe>,
        health_url: Url,
        server_health_sender: watch::Sender<Option<ServerHealth>>,
    ) -> Self {
        let cancel = CancellationToken::new();
        tokio::spawn(monitor(
            probe,
            health_url,
            server_health_sender,
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

/// Probe `health_url` until cancelled, sleeping after each probe for as long
/// as its verdict asks. Sleeping after each probe, rather than ticking at a
/// fixed period, means a slow probe never bursts catch-up probes.
async fn monitor(
    probe: Arc<dyn HealthProbe>,
    health_url: Url,
    server_health_sender: watch::Sender<Option<ServerHealth>>,
    cancel: CancellationToken,
) {
    let mut next_delay = PROBE_INTERVAL;
    loop {
        tokio::select! {
            () = tokio::time::sleep(next_delay) => {}
            () = cancel.cancelled() => return,
        }
        let server_health = tokio::select! {
            server_health = probe_once(probe.as_ref(), &health_url) => server_health,
            () = cancel.cancelled() => return,
        };
        next_delay = match server_health {
            ServerHealth::Reachable(_) => REACHABLE_PROBE_INTERVAL,
            ServerHealth::Unreachable { .. } => PROBE_INTERVAL,
        };
        server_health_sender.send_if_modified(|published| {
            if published
                .as_ref()
                .is_some_and(|published| says_the_same(published, &server_health))
            {
                return false;
            }
            *published = Some(server_health);
            true
        });
    }
}

/// Whether `probed` tells the host nothing `published` didn't: the same
/// unreachable reason, or reports whose overall and per-check statuses agree.
/// Each check's `time` is when it ran, so it differs on every probe; comparing
/// it would republish a steady server every 30 s.
fn says_the_same(published: &ServerHealth, probed: &ServerHealth) -> bool {
    match (published, probed) {
        (ServerHealth::Reachable(published), ServerHealth::Reachable(probed)) => {
            published.status == probed.status
                && check_statuses(published).eq(check_statuses(probed))
        }
        (
            ServerHealth::Unreachable {
                error: published_error,
            },
            ServerHealth::Unreachable {
                error: probed_error,
            },
        ) => published_error == probed_error,
        _ => false,
    }
}

/// Each of `report`'s checks as its name, component type and status: the
/// check without its `time`.
fn check_statuses(
    report: &HealthReport,
) -> impl Iterator<Item = (&str, ComponentType, HealthStatus)> {
    report.checks.iter().flat_map(|(check_name, checks)| {
        checks
            .iter()
            .map(move |check| (check_name.as_str(), check.component_type, check.status))
    })
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

    use std::collections::BTreeMap;

    use shared_structures_rust::health_check::HealthCheck;
    use std::sync::Mutex;
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

    /// A report of one `server` check with `status`, run at `time`.
    fn report_at(status: HealthStatus, time: &str) -> HealthReport {
        HealthReport::from_checks(BTreeMap::from([(
            "server".to_owned(),
            vec![HealthCheck {
                component_type: ComponentType::System,
                status,
                time: time.parse().expect("an RFC 3339 time"),
            }],
        )]))
    }

    fn spawn(
        probe: Arc<ScriptedProbe>,
    ) -> (ReachabilityMonitor, watch::Receiver<Option<ServerHealth>>) {
        let (server_health_sender, server_health) = watch::channel(None);
        let monitor = ReachabilityMonitor::spawn(probe, health_url(), server_health_sender);
        (monitor, server_health)
    }

    #[tokio::test(start_paused = true)]
    async fn nothing_is_published_before_the_first_probe() {
        let probe = ScriptedProbe::new([Answer::Report(HealthReport::pass())]);
        let (_monitor, server_health) = spawn(Arc::clone(&probe));
        tokio::time::sleep(Duration::from_millis(399)).await;
        assert_eq!(*server_health.borrow(), None);
        assert!(probe.probe_times().is_empty());
    }

    /// Unreachable while the probe fails, every 400 ms; reachable once it
    /// answers, then re-probed every 30 s.
    #[tokio::test(start_paused = true)]
    async fn goes_from_unreachable_to_reachable_and_slows_down() {
        let started = Instant::now();
        let probe = ScriptedProbe::new([
            Answer::Refused,
            Answer::Refused,
            Answer::Report(HealthReport::pass()),
        ]);
        let (_monitor, mut server_health) = spawn(Arc::clone(&probe));

        let unreachable = server_health
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
        server_health
            .wait_for(|health| health == &Some(ServerHealth::Reachable(HealthReport::pass())))
            .await
            .expect("reachable");
        tokio::time::sleep(Duration::from_secs(61)).await;

        let offsets: Vec<Duration> = probe
            .probe_times()
            .into_iter()
            .map(|at| at - started)
            .collect();
        assert_eq!(
            offsets[..5],
            [
                Duration::from_millis(400),
                Duration::from_millis(800),
                Duration::from_millis(1200),
                Duration::from_millis(31_200),
                Duration::from_millis(61_200),
            ]
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

    #[tokio::test(start_paused = true)]
    async fn a_reachable_server_drops_to_unreachable_with_the_error() {
        let probe = ScriptedProbe::new([Answer::Report(HealthReport::pass()), Answer::Refused]);
        let (_monitor, mut server_health) = spawn(probe);
        server_health
            .wait_for(|health| matches!(health, Some(ServerHealth::Reachable(_))))
            .await
            .expect("reachable");
        let dropped = server_health
            .wait_for(|health| matches!(health, Some(ServerHealth::Unreachable { .. })))
            .await
            .expect("unreachable")
            .clone();
        assert_eq!(
            dropped,
            Some(ServerHealth::Unreachable {
                error: "connection refused".to_owned()
            })
        );
    }

    /// A server that answers `fail` is reachable: it answered.
    #[tokio::test(start_paused = true)]
    async fn a_failing_report_is_still_reachable() {
        let probe = ScriptedProbe::new([Answer::Report(failing_report())]);
        let (_monitor, mut server_health) = spawn(probe);
        let reached = server_health
            .wait_for(Option::is_some)
            .await
            .expect("published")
            .clone();
        assert_eq!(reached, Some(ServerHealth::Reachable(failing_report())));
    }

    /// Each probe's checks carry the time they ran, which differs every time;
    /// a server whose statuses hold still is published once, and a changed
    /// status is published again.
    #[tokio::test(start_paused = true)]
    async fn only_a_changed_verdict_is_republished() {
        let probe = ScriptedProbe::new([
            Answer::Report(report_at(HealthStatus::Pass, "2026-10-06T00:00:00Z")),
            Answer::Report(report_at(HealthStatus::Pass, "2026-10-06T00:00:30Z")),
            Answer::Report(report_at(HealthStatus::Pass, "2026-10-06T00:01:00Z")),
            Answer::Report(report_at(HealthStatus::Warn, "2026-10-06T00:01:30Z")),
        ]);
        let (_monitor, mut server_health) = spawn(Arc::clone(&probe));
        server_health
            .wait_for(Option::is_some)
            .await
            .expect("published");
        server_health.borrow_and_update();

        tokio::time::sleep(Duration::from_secs(61)).await;
        assert_eq!(probe.probe_times().len(), 3);
        assert!(
            !server_health
                .has_changed()
                .expect("the monitor holds the sender"),
            "the same statuses at a later time are not a change"
        );

        tokio::time::sleep(Duration::from_secs(30)).await;
        assert!(server_health
            .has_changed()
            .expect("the monitor holds the sender"));
        assert_eq!(
            *server_health.borrow_and_update(),
            Some(ServerHealth::Reachable(report_at(
                HealthStatus::Warn,
                "2026-10-06T00:01:30Z"
            )))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_probe_that_never_answers_is_unreachable_after_the_timeout() {
        let started = Instant::now();
        let probe = ScriptedProbe::new([Answer::Hang]);
        let (_monitor, mut server_health) = spawn(probe);
        let unreachable = server_health
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
        let (monitor, mut server_health) = spawn(Arc::clone(&probe));
        server_health
            .wait_for(Option::is_some)
            .await
            .expect("published");
        drop(monitor);
        let probes_at_drop = probe.probe_times().len();
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert_eq!(probe.probe_times().len(), probes_at_drop);
    }
}
