//! [`ServerStatus`], what the base shows of a server's run, and
//! [`ServerStatuses`], which keeps each server's and emits it as the
//! [`SERVER_STATUS_EVENT`] whenever it changes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use chrono::{DateTime, Utc};
use serde::Serialize;
use shared_structures_rust::server_run_state::ServerRunState;
use shared_structures_rust::tunnel_service::TunnelLiveness;

/// The Tauri event each [`ServerStatus`] change is emitted on, with the
/// status as its payload.
pub const SERVER_STATUS_EVENT: &str = "server-status";

/// Where one server's run is, as the base shows it. Live state, held by the
/// host only and never written to `servers.json`.
///
/// Serialised camelCase:
/// `{"domain", "runState": {"state", "error"?}, "tunnelLiveness", "startedAt"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    /// The server's domain, its identity.
    pub domain: String,
    /// Where its run is: `Stopped { error: None }` until it first starts.
    pub run_state: ServerRunState,
    /// Its tunnel's liveness while it runs; `null` while it doesn't.
    pub tunnel_liveness: Option<TunnelLiveness>,
    /// When the current run began serving: set as it reaches `Running`, and
    /// `null` while it is starting or stopped.
    pub started_at: Option<DateTime<Utc>>,
}

impl ServerStatus {
    /// The status of a server that hasn't run since the app started.
    #[must_use]
    pub fn stopped(domain: &str) -> Self {
        Self {
            domain: domain.to_owned(),
            run_state: ServerRunState::Stopped { error: None },
            tunnel_liveness: None,
            started_at: None,
        }
    }

    /// This status with its run in `run_state`, reported at `now`. A run that
    /// reaches `Running` started at `now`, unless it was already running; any
    /// other state has no start time.
    #[must_use]
    pub fn with_run_state(self, run_state: ServerRunState, now: DateTime<Utc>) -> Self {
        let started_at = match (&run_state, &self.run_state) {
            (ServerRunState::Running, ServerRunState::Running) => self.started_at,
            (ServerRunState::Running, _) => Some(now),
            (ServerRunState::Starting | ServerRunState::Stopped { .. }, _) => None,
        };
        Self {
            run_state,
            started_at,
            ..self
        }
    }
}

/// Every server's current [`ServerStatus`], emitted through `emit` whenever
/// one changes. A server nothing has been reported for is
/// [`ServerStatus::stopped`]. `Clone` shares the statuses.
#[derive(Clone)]
pub struct ServerStatuses {
    statuses: Arc<Mutex<HashMap<String, ServerStatus>>>,
    emit: Arc<dyn Fn(&ServerStatus) + Send + Sync>,
}

impl ServerStatuses {
    /// No statuses yet; each change is passed to `emit`, which the host
    /// points at the [`SERVER_STATUS_EVENT`].
    pub fn new(emit: impl Fn(&ServerStatus) + Send + Sync + 'static) -> Self {
        Self {
            statuses: Arc::default(),
            emit: Arc::new(emit),
        }
    }

    /// The current status of the server with `domain`.
    #[must_use]
    pub fn current(&self, domain: &str) -> ServerStatus {
        self.lock()
            .get(domain)
            .cloned()
            .unwrap_or_else(|| ServerStatus::stopped(domain))
    }

    /// The server with `domain`'s run is in `run_state`, as of `now`.
    pub fn report_run_state(&self, domain: &str, run_state: ServerRunState, now: DateTime<Utc>) {
        self.change(domain, |status| status.with_run_state(run_state, now));
    }

    /// The server with `domain`'s tunnel liveness is `tunnel_liveness`.
    pub fn report_tunnel_liveness(&self, domain: &str, tunnel_liveness: Option<TunnelLiveness>) {
        self.change(domain, |status| ServerStatus {
            tunnel_liveness,
            ..status
        });
    }

    /// Drop the status of a server that has been removed. Nothing is emitted.
    pub(crate) fn forget(&self, domain: &str) {
        self.lock().remove(domain);
    }

    /// Apply `change` to the server's status, and emit the result if it
    /// differs. Emitted while the statuses are locked, so the events go out in
    /// the order the changes were made.
    fn change(&self, domain: &str, change: impl FnOnce(ServerStatus) -> ServerStatus) {
        let mut statuses = self.lock();
        let current = statuses
            .get(domain)
            .cloned()
            .unwrap_or_else(|| ServerStatus::stopped(domain));
        let changed = change(current.clone());
        if changed != current {
            (self.emit)(&changed);
            statuses.insert(domain.to_owned(), changed);
        }
    }

    /// The statuses. Every change replaces a whole status, so a panic can't
    /// leave one half-written, and a poisoned lock's statuses are still whole.
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, ServerStatus>> {
        self.statuses.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use chrono::{TimeDelta, TimeZone};
    use shared_structures_rust::tunnel_service::TunnelStatus;

    use super::*;

    const DOMAIN: &str = "ruth.relay.example.com";

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 6, 17, 0, 0).unwrap()
    }

    /// Statuses whose every emitted change is collected, in order.
    pub(crate) fn collected_statuses() -> (ServerStatuses, Arc<Mutex<Vec<ServerStatus>>>) {
        let emitted: Arc<Mutex<Vec<ServerStatus>>> = Arc::default();
        let collector = Arc::clone(&emitted);
        let statuses = ServerStatuses::new(move |status| {
            collector.lock().unwrap().push(status.clone());
        });
        (statuses, emitted)
    }

    fn verified_tunnel() -> TunnelLiveness {
        TunnelLiveness {
            settings_revision: Some(3),
            status: TunnelStatus::Verified,
            origin: "https://ruth.relay.example.com".to_owned(),
            public_host: Some("ruth.relay.example.com".to_owned()),
            error: None,
            dial_attempts: 1,
        }
    }

    #[test]
    fn a_server_nothing_was_reported_for_is_stopped_without_an_error() {
        let (statuses, emitted) = collected_statuses();
        assert_eq!(statuses.current(DOMAIN), ServerStatus::stopped(DOMAIN));
        assert!(emitted.lock().unwrap().is_empty());
    }

    #[test]
    fn started_at_is_set_on_running_and_cleared_on_stop() {
        let (statuses, emitted) = collected_statuses();

        statuses.report_run_state(DOMAIN, ServerRunState::Starting, now());
        statuses.report_run_state(DOMAIN, ServerRunState::Running, now());
        statuses.report_run_state(
            DOMAIN,
            ServerRunState::Running,
            now() + TimeDelta::minutes(5),
        );
        statuses.report_run_state(
            DOMAIN,
            ServerRunState::Stopped { error: None },
            now() + TimeDelta::minutes(9),
        );

        let started_ats: Vec<(ServerRunState, Option<DateTime<Utc>>)> = emitted
            .lock()
            .unwrap()
            .iter()
            .map(|status| (status.run_state.clone(), status.started_at))
            .collect();
        assert_eq!(
            started_ats,
            vec![
                (ServerRunState::Starting, None),
                (ServerRunState::Running, Some(now())),
                (ServerRunState::Stopped { error: None }, None),
            ]
        );
    }

    #[test]
    fn a_failed_start_is_emitted_with_its_error() {
        let (statuses, emitted) = collected_statuses();
        let failed = ServerRunState::Stopped {
            error: Some("the server's config couldn't be built".to_owned()),
        };

        statuses.report_run_state(DOMAIN, failed.clone(), now());

        assert_eq!(
            *emitted.lock().unwrap(),
            vec![ServerStatus {
                run_state: failed,
                ..ServerStatus::stopped(DOMAIN)
            }]
        );
    }

    #[test]
    fn only_a_change_is_emitted() {
        let (statuses, emitted) = collected_statuses();

        statuses.report_run_state(DOMAIN, ServerRunState::Stopped { error: None }, now());
        statuses.report_tunnel_liveness(DOMAIN, None);
        statuses.report_tunnel_liveness(DOMAIN, Some(verified_tunnel()));
        statuses.report_tunnel_liveness(DOMAIN, Some(verified_tunnel()));

        assert_eq!(
            *emitted.lock().unwrap(),
            vec![ServerStatus {
                tunnel_liveness: Some(verified_tunnel()),
                ..ServerStatus::stopped(DOMAIN)
            }]
        );
    }

    #[test]
    fn each_server_has_its_own_status() {
        let (statuses, _emitted) = collected_statuses();

        statuses.report_run_state(DOMAIN, ServerRunState::Running, now());

        assert_eq!(statuses.current(DOMAIN).run_state, ServerRunState::Running);
        assert_eq!(
            statuses.current("lab.relay.example.com"),
            ServerStatus::stopped("lab.relay.example.com")
        );
    }

    #[test]
    fn a_forgotten_server_is_stopped_again() {
        let (statuses, _emitted) = collected_statuses();
        statuses.report_run_state(DOMAIN, ServerRunState::Running, now());

        statuses.forget(DOMAIN);

        assert_eq!(statuses.current(DOMAIN), ServerStatus::stopped(DOMAIN));
    }

    #[test]
    fn a_status_serialises_camel_case() {
        let status = ServerStatus {
            tunnel_liveness: Some(verified_tunnel()),
            ..ServerStatus::stopped(DOMAIN).with_run_state(ServerRunState::Running, now())
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({
                "domain": DOMAIN,
                "runState": {"state": "running"},
                "tunnelLiveness": {
                    "settingsRevision": 3,
                    "status": "verified",
                    "origin": "https://ruth.relay.example.com",
                    "publicHost": "ruth.relay.example.com",
                    "error": null,
                    "dialAttempts": 1,
                },
                "startedAt": "2026-10-06T17:00:00Z",
            })
        );
    }
}
