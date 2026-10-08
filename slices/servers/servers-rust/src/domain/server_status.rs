//! [`ServerStatus`], a server's status on `UnitRunner` as the base receives
//! it, and [`ServerStatusTracker`], which picks the statuses that changed out
//! of `UnitRunner`'s statuses.
//!
//! The status is `UnitRunner`'s own `UnitStatus<ServerDetail>`, keyed by the
//! server's domain; only its serialisation is the servers slice's. It is
//! written camelCase, with each optional member left out when it is `None`:
//!
//! ```json
//! {
//!   "domain": "ruth.relay.example.com",
//!   "runState": "starting" | "running" | "stopped",
//!   "lastStop": {
//!     "reason": "policyInactive" | "replaced" | "removed" | "stoppedForRestart"
//!             | "endedOnItsOwn" | "sessionEndedByPlatform",
//!     "platformReason": "userStop" | "platformTimeout" | …,
//!     "error": "…",
//!     "stoppedAt": "<RFC 3339>"
//!   },
//!   "runningSince": "<RFC 3339>",
//!   "health": {"kind": "reachable", "status": "pass" | "warn" | "fail"}
//!           | {"kind": "unreachable", "error": "…"}
//! }
//! ```
//!
//! `lastStop` is there only while the run state is `stopped`, and only once
//! the server has run; `platformReason` only for `sessionEndedByPlatform`;
//! `runningSince` only while `running`; `health` only while a run has
//! reported it.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Serialize, Serializer};
use shared_structures_rust::health_check::HealthStatus;
use unit_runner::{
    PlatformStopReason, RunState, RunStop, StopReason, UnitId, UnitStatus, UnitStatuses,
};
use wildflower_server_rust::ServerHealth;

use crate::domain::ServerDetail;

/// One server's status on `UnitRunner`: `UnitRunner`'s [`UnitStatus`] for the
/// unit whose id is the server's `domain`.
///
/// `Serialize` writes the camelCase shape the [module docs](self) give.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerStatus {
    /// The server's domain, its unit id.
    pub domain: String,
    /// What `UnitRunner` reports for the server.
    pub unit_status: UnitStatus<ServerDetail>,
}

impl Serialize for ServerStatus {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        ServerStatusWire::of(&self.domain, &self.unit_status).serialize(serializer)
    }
}

/// [`ServerStatus`]'s wire shape, borrowed from the status it writes.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerStatusWire<'a> {
    domain: &'a str,
    run_state: RunStateWire,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_stop: Option<RunStopWire<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    running_since: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    health: Option<ServerHealthWire<'a>>,
}

impl<'a> ServerStatusWire<'a> {
    /// The wire shape of the server `domain`'s `unit_status`.
    pub(crate) fn of(domain: &'a str, unit_status: &'a UnitStatus<ServerDetail>) -> Self {
        let (run_state, last_stop) = match &unit_status.run_state {
            RunState::Starting => (RunStateWire::Starting, None),
            RunState::Running => (RunStateWire::Running, None),
            RunState::Stopped { last_stop } => (
                RunStateWire::Stopped,
                last_stop.as_ref().map(RunStopWire::of),
            ),
        };
        Self {
            domain,
            run_state,
            last_stop,
            running_since: unit_status.running_since,
            health: unit_status
                .detail
                .as_ref()
                .and_then(|detail| detail.health.as_ref())
                .map(ServerHealthWire::of),
        }
    }
}

/// [`RunState`] without the stop it carries.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum RunStateWire {
    Starting,
    Running,
    Stopped,
}

/// [`RunStop`]'s wire shape, its reason flattened into `reason` and
/// `platformReason`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunStopWire<'a> {
    reason: StopReasonWire,
    #[serde(skip_serializing_if = "Option::is_none")]
    platform_reason: Option<PlatformStopReasonWire>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
    stopped_at: DateTime<Utc>,
}

impl<'a> RunStopWire<'a> {
    fn of(stop: &'a RunStop) -> Self {
        let (reason, platform_reason) = match stop.reason {
            StopReason::PolicyInactive => (StopReasonWire::PolicyInactive, None),
            StopReason::Replaced => (StopReasonWire::Replaced, None),
            StopReason::Removed => (StopReasonWire::Removed, None),
            StopReason::StoppedForRestart => (StopReasonWire::StoppedForRestart, None),
            StopReason::EndedOnItsOwn => (StopReasonWire::EndedOnItsOwn, None),
            StopReason::SessionEndedByPlatform { platform_reason } => (
                StopReasonWire::SessionEndedByPlatform,
                Some(PlatformStopReasonWire::of(platform_reason)),
            ),
        };
        Self {
            reason,
            platform_reason,
            error: stop.error.as_deref(),
            stopped_at: stop.stopped_at,
        }
    }
}

/// [`StopReason`]'s wire names.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum StopReasonWire {
    PolicyInactive,
    Replaced,
    Removed,
    StoppedForRestart,
    EndedOnItsOwn,
    SessionEndedByPlatform,
}

/// [`PlatformStopReason`]'s wire names.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum PlatformStopReasonWire {
    UserStop,
    PlatformTimeout,
    PlatformExpiration,
    NativeNotificationStop,
    OsRestart,
    BootRecovery,
    TaskCompleted,
    Error,
    ProcessExit,
    Unknown,
}

impl PlatformStopReasonWire {
    fn of(platform_reason: PlatformStopReason) -> Self {
        match platform_reason {
            PlatformStopReason::UserStop => Self::UserStop,
            PlatformStopReason::PlatformTimeout => Self::PlatformTimeout,
            PlatformStopReason::PlatformExpiration => Self::PlatformExpiration,
            PlatformStopReason::NativeNotificationStop => Self::NativeNotificationStop,
            PlatformStopReason::OsRestart => Self::OsRestart,
            PlatformStopReason::BootRecovery => Self::BootRecovery,
            PlatformStopReason::TaskCompleted => Self::TaskCompleted,
            PlatformStopReason::Error => Self::Error,
            PlatformStopReason::ProcessExit => Self::ProcessExit,
            PlatformStopReason::Unknown => Self::Unknown,
        }
    }
}

/// [`ServerHealth`]'s wire shape: whether `/health` answered through the
/// public origin, and the overall status it answered with. The report's
/// checks stay with the server.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum ServerHealthWire<'a> {
    Reachable { status: HealthStatus },
    Unreachable { error: &'a str },
}

impl<'a> ServerHealthWire<'a> {
    fn of(health: &'a ServerHealth) -> Self {
        match health {
            ServerHealth::Reachable(report) => Self::Reachable {
                status: report.status,
            },
            ServerHealth::Unreachable { error } => Self::Unreachable { error },
        }
    }
}

/// Picks the servers whose status changed out of `UnitRunner`'s
/// statuses, whose unit ids are the servers' domains, so the host sends the
/// base one status per change.
///
/// A server that leaves the statuses, because it was removed, is forgotten
/// and gets no status of its own: the base drops a server it no longer
/// lists. The statuses are read as `UnitRunner`'s watch holds them, so a
/// status a later one replaced before it was read is never sent.
#[derive(Debug, Default)]
pub struct ServerStatusTracker {
    last_sent: BTreeMap<UnitId, UnitStatus<ServerDetail>>,
}

impl ServerStatusTracker {
    /// A tracker that has sent nothing, so its first call returns every
    /// status.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The statuses in `statuses` that differ from the ones last returned
    /// for the same server, or that are new, in domain order.
    pub fn changed_statuses(&mut self, statuses: &UnitStatuses<ServerDetail>) -> Vec<ServerStatus> {
        let changed = statuses
            .iter()
            .filter(|(unit_id, unit_status)| self.last_sent.get(*unit_id) != Some(*unit_status))
            .map(|(unit_id, unit_status)| ServerStatus {
                domain: unit_id.as_str().to_owned(),
                unit_status: unit_status.clone(),
            })
            .collect();
        self.last_sent.clone_from(statuses);
        changed
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use chrono::TimeZone;
    use shared_structures_rust::health_check::HealthReport;
    use unit_runner::RunPolicy;

    use super::*;
    use crate::domain::{RegistryError, RunPolicyChoice, ServerChangeError};

    pub(crate) const RUTH: &str = "ruth.relay.example.com";
    pub(crate) const LAB: &str = "lab.rathole.example.com";

    fn at(minute: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 6, 17, minute, 0).unwrap()
    }

    /// A run that is up, its `/health` answering `pass` through the relay.
    pub(crate) fn running_and_reachable() -> UnitStatus<ServerDetail> {
        UnitStatus {
            run_state: RunState::Running,
            running_since: Some(at(0)),
            detail: Some(ServerDetail {
                health: Some(ServerHealth::Reachable(HealthReport::pass())),
            }),
        }
    }

    /// A run whose config couldn't be built.
    pub(crate) fn stopped_with_an_error() -> UnitStatus<ServerDetail> {
        UnitStatus {
            run_state: RunState::Stopped {
                last_stop: Some(RunStop {
                    reason: StopReason::EndedOnItsOwn,
                    error: Some("the server's config couldn't be built".to_owned()),
                    stopped_at: at(3),
                }),
            },
            running_since: None,
            detail: None,
        }
    }

    /// Every status the golden file pins, under its name there.
    pub(crate) fn golden_statuses() -> Vec<(&'static str, ServerStatus)> {
        let status = |unit_status| ServerStatus {
            domain: RUTH.to_owned(),
            unit_status,
        };
        vec![
            ("runningAndReachable", status(running_and_reachable())),
            (
                "startingUnchecked",
                status(UnitStatus {
                    run_state: RunState::Starting,
                    running_since: None,
                    detail: None,
                }),
            ),
            (
                "runningUnreachable",
                status(UnitStatus {
                    run_state: RunState::Running,
                    running_since: Some(at(0)),
                    detail: Some(ServerDetail {
                        health: Some(ServerHealth::Unreachable {
                            error: "the relay answered 502".to_owned(),
                        }),
                    }),
                }),
            ),
            ("neverRun", status(UnitStatus::never_run())),
            ("stoppedWithAnError", status(stopped_with_an_error())),
            (
                "stoppedByThePlatform",
                status(UnitStatus {
                    run_state: RunState::Stopped {
                        last_stop: Some(RunStop {
                            reason: StopReason::SessionEndedByPlatform {
                                platform_reason: PlatformStopReason::PlatformTimeout,
                            },
                            error: None,
                            stopped_at: at(9),
                        }),
                    },
                    running_since: None,
                    detail: None,
                }),
            ),
            (
                "stoppedAsItsPolicyEnded",
                status(UnitStatus {
                    run_state: RunState::Stopped {
                        last_stop: Some(RunStop {
                            reason: StopReason::PolicyInactive,
                            error: None,
                            stopped_at: at(42),
                        }),
                    },
                    running_since: None,
                    detail: None,
                }),
            ),
        ]
    }

    /// The golden wire file both this crate's tests and `servers-core`'s
    /// decoder tests read.
    pub(crate) fn golden() -> serde_json::Value {
        serde_json::from_str(include_str!("../../../servers-wire-golden.json")).unwrap()
    }

    #[test]
    fn each_status_serialises_as_the_golden_file_says() {
        let golden = golden();
        for (name, status) in golden_statuses() {
            assert_eq!(
                serde_json::to_value(&status).unwrap(),
                golden["serverStatuses"][name],
                "{name}"
            );
        }
        assert_eq!(
            golden["serverStatuses"].as_object().unwrap().len(),
            golden_statuses().len(),
            "every golden status is checked"
        );
    }

    /// The run policies, choices and command errors the base decodes are
    /// the ones the golden file holds.
    #[test]
    fn the_policies_choices_and_errors_are_as_the_golden_file_says() {
        let golden = golden();
        let policies = [
            RunPolicy::Off,
            RunPolicy::WhileOpen,
            RunPolicy::Until { at: at(42) },
            RunPolicy::Always,
        ];
        assert_eq!(
            serde_json::to_value(policies).unwrap(),
            golden["runPolicies"]
        );
        assert_eq!(
            serde_json::from_value::<Vec<RunPolicyChoice>>(golden["runPolicyChoices"].clone())
                .unwrap(),
            [
                RunPolicyChoice::Off,
                RunPolicyChoice::WhileOpen,
                RunPolicyChoice::For { seconds: 1800 },
                RunPolicyChoice::Always,
            ]
        );
        let errors = [
            ServerChangeError::NonPositiveDuration { seconds: 0 },
            ServerChangeError::Registry(RegistryError::UnsupportedVersion { version: 3 }),
            ServerChangeError::Registry(RegistryError::NotRegistered {
                domain: "lab.relay.example.com".to_owned(),
            }),
        ];
        assert_eq!(
            serde_json::to_value(errors).unwrap(),
            golden["commandErrors"]
        );
    }

    #[test]
    fn every_stop_reason_has_its_own_name() {
        let reasons = [
            (StopReason::PolicyInactive, "policyInactive"),
            (StopReason::Replaced, "replaced"),
            (StopReason::Removed, "removed"),
            (StopReason::StoppedForRestart, "stoppedForRestart"),
            (StopReason::EndedOnItsOwn, "endedOnItsOwn"),
        ];
        for (reason, name) in reasons {
            let stop = RunStop {
                reason,
                error: None,
                stopped_at: at(0),
            };
            assert_eq!(
                serde_json::to_value(RunStopWire::of(&stop)).unwrap(),
                serde_json::json!({"reason": name, "stoppedAt": "2026-10-06T17:00:00Z"})
            );
        }
        let platform_reasons = [
            (PlatformStopReason::UserStop, "userStop"),
            (PlatformStopReason::PlatformTimeout, "platformTimeout"),
            (PlatformStopReason::PlatformExpiration, "platformExpiration"),
            (
                PlatformStopReason::NativeNotificationStop,
                "nativeNotificationStop",
            ),
            (PlatformStopReason::OsRestart, "osRestart"),
            (PlatformStopReason::BootRecovery, "bootRecovery"),
            (PlatformStopReason::TaskCompleted, "taskCompleted"),
            (PlatformStopReason::Error, "error"),
            (PlatformStopReason::ProcessExit, "processExit"),
            (PlatformStopReason::Unknown, "unknown"),
        ];
        for (platform_reason, name) in platform_reasons {
            let stop = RunStop {
                reason: StopReason::SessionEndedByPlatform { platform_reason },
                error: None,
                stopped_at: at(0),
            };
            assert_eq!(
                serde_json::to_value(RunStopWire::of(&stop)).unwrap()["platformReason"],
                name
            );
        }
    }

    fn statuses(
        entries: impl IntoIterator<Item = (&'static str, UnitStatus<ServerDetail>)>,
    ) -> UnitStatuses<ServerDetail> {
        entries
            .into_iter()
            .map(|(domain, status)| (UnitId::from(domain), status))
            .collect()
    }

    fn domains(changed: &[ServerStatus]) -> Vec<&str> {
        changed
            .iter()
            .map(|status| status.domain.as_str())
            .collect()
    }

    #[test]
    fn the_first_read_sends_every_status() {
        let mut tracker = ServerStatusTracker::new();
        let changed = tracker.changed_statuses(&statuses([
            (RUTH, running_and_reachable()),
            (LAB, UnitStatus::never_run()),
        ]));
        assert_eq!(domains(&changed), [LAB, RUTH]);
        assert_eq!(changed[1].unit_status, running_and_reachable());
    }

    #[test]
    fn only_the_servers_whose_status_changed_are_sent() {
        let mut tracker = ServerStatusTracker::new();
        tracker.changed_statuses(&statuses([
            (RUTH, UnitStatus::never_run()),
            (LAB, UnitStatus::never_run()),
        ]));

        let changed = tracker.changed_statuses(&statuses([
            (RUTH, running_and_reachable()),
            (LAB, UnitStatus::never_run()),
        ]));
        assert_eq!(domains(&changed), [RUTH]);

        let changed = tracker.changed_statuses(&statuses([
            (RUTH, running_and_reachable()),
            (LAB, UnitStatus::never_run()),
        ]));
        assert!(changed.is_empty());
    }

    #[test]
    fn a_removed_server_is_forgotten_and_sent_whole_if_it_comes_back() {
        let mut tracker = ServerStatusTracker::new();
        tracker.changed_statuses(&statuses([
            (RUTH, UnitStatus::never_run()),
            (LAB, stopped_with_an_error()),
        ]));

        let changed = tracker.changed_statuses(&statuses([(RUTH, UnitStatus::never_run())]));
        assert!(changed.is_empty(), "a removal sends nothing");

        let changed = tracker.changed_statuses(&statuses([
            (RUTH, UnitStatus::never_run()),
            (LAB, stopped_with_an_error()),
        ]));
        assert_eq!(domains(&changed), [LAB]);
    }
}
