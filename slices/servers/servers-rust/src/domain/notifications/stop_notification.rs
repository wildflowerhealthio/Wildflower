//! The notification for a server's run that stopped, keyed by `UnitRunner`'s
//! [`StopReason`], and [`StopNotificationTracker`], which picks each server's
//! new stops out of `UnitRunner`'s statuses.

use std::collections::BTreeMap;

use unit_runner::{PlatformStopReason, RunState, RunStop, StopReason, UnitId, UnitStatuses};

use crate::domain::notifications::local_notification::LocalNotification;

/// The start of a server's stop notification id, which its domain completes,
/// so a burst of one server's stops replaces that server's one notification
/// instead of stacking, and never another server's.
pub const SERVER_STOPPED_NOTIFICATION_ID_PREFIX: &str = "server-stopped:";

/// The title of a stop the server doesn't come back from by itself.
const STOPPED_TITLE: &str = "Wildflower server stopped";

/// The title of a stop the platform made for the app's time in the
/// background, which ends when the app becomes present again.
const PAUSED_TITLE: &str = "Wildflower server paused";

/// The notification for the run of the server `domain` that stopped as `stop`
/// says, or `None` for a stop `UnitRunner` made itself: the app set the server
/// again or removed it, its policy stopped wanting it running, or `UnitRunner`
/// restarted it. A run that ended on its own and a run the platform's end of
/// the background session stopped notify.
#[must_use]
pub fn stop_notification(domain: &str, stop: &RunStop) -> Option<LocalNotification> {
    let (title, text) = match stop.reason {
        StopReason::PolicyInactive
        | StopReason::Replaced
        | StopReason::Removed
        | StopReason::StoppedForRestart => return None,
        StopReason::EndedOnItsOwn => match &stop.error {
            Some(error) => (STOPPED_TITLE, error.as_str()),
            None => (STOPPED_TITLE, "The server stopped."),
        },
        StopReason::SessionEndedByPlatform { platform_reason } => session_end_text(platform_reason),
    };
    Some(LocalNotification {
        id: format!("{SERVER_STOPPED_NOTIFICATION_ID_PREFIX}{domain}"),
        title: title.to_owned(),
        body: format!("{domain}: {text}"),
    })
}

/// The title and text for a run the platform stopped by ending the background
/// session for `platform_reason`.
fn session_end_text(platform_reason: PlatformStopReason) -> (&'static str, &'static str) {
    match platform_reason {
        PlatformStopReason::UserStop => (STOPPED_TITLE, "The server was stopped."),
        PlatformStopReason::NativeNotificationStop => (
            STOPPED_TITLE,
            "The server was stopped from its notification.",
        ),
        PlatformStopReason::TaskCompleted => (STOPPED_TITLE, "The background service ended."),
        PlatformStopReason::Error => (
            STOPPED_TITLE,
            "The background service stopped after an error.",
        ),
        PlatformStopReason::PlatformTimeout => (PAUSED_TITLE, "Android ended its background time."),
        PlatformStopReason::PlatformExpiration => {
            (PAUSED_TITLE, "iOS ended the background window.")
        }
        PlatformStopReason::ProcessExit => {
            (PAUSED_TITLE, "The app was closed or put in the background.")
        }
        PlatformStopReason::OsRestart => (
            STOPPED_TITLE,
            "The system restarted the background service.",
        ),
        PlatformStopReason::BootRecovery => (
            STOPPED_TITLE,
            "The background service stopped while recovering after a restart of the device.",
        ),
        PlatformStopReason::Unknown => (STOPPED_TITLE, "The system ended the background service."),
    }
}

/// Picks each server's new stops out of `UnitRunner`'s statuses, whose
/// unit ids are the servers' domains, and decides which of them notify.
///
/// Each stop notifies once, as [`stop_notification`] says. `UnitRunner` retries
/// a failed run every few seconds, so a failure with the same error as the one
/// last notified for that server doesn't notify again until the server has
/// run.
///
/// The statuses are read as `UnitRunner`'s watch holds them: a stop that a
/// later one replaced before it was read is never seen.
#[derive(Debug, Default)]
pub struct StopNotificationTracker {
    servers: BTreeMap<UnitId, TrackedServer>,
}

/// What the tracker remembers about one server.
#[derive(Debug, Default)]
struct TrackedServer {
    /// The latest stop seen, so it is never taken as new twice.
    last_stop: Option<RunStop>,
    /// The error of the failure last notified, until the server runs again.
    notified_failure: Option<String>,
}

impl StopNotificationTracker {
    /// A tracker that has seen no stops.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The notifications for the stops in `statuses` this tracker hasn't seen
    /// yet, in domain order. Servers missing from `statuses` are forgotten.
    pub fn new_stop_notifications<D>(
        &mut self,
        statuses: &UnitStatuses<D>,
    ) -> Vec<LocalNotification> {
        self.servers
            .retain(|unit_id, _| statuses.contains_key(unit_id));
        let mut notifications = Vec::new();
        for (unit_id, status) in statuses {
            let server = self.servers.entry(unit_id.clone()).or_default();
            match &status.run_state {
                RunState::Running => server.notified_failure = None,
                RunState::Starting | RunState::Stopped { last_stop: None } => {}
                RunState::Stopped {
                    last_stop: Some(stop),
                } => {
                    if server.last_stop.as_ref() == Some(stop) {
                        continue;
                    }
                    server.last_stop = Some(stop.clone());
                    notifications.extend(server.notification_for_new(unit_id, stop));
                }
            }
        }
        notifications
    }
}

impl TrackedServer {
    /// The notification for `stop`, a stop of this server not seen before,
    /// or `None` when it doesn't notify or repeats the failure last notified.
    fn notification_for_new(
        &mut self,
        unit_id: &UnitId,
        stop: &RunStop,
    ) -> Option<LocalNotification> {
        if let (StopReason::EndedOnItsOwn, Some(error)) = (stop.reason, &stop.error) {
            if self.notified_failure.as_ref() == Some(error) {
                return None;
            }
            self.notified_failure = Some(error.clone());
        }
        stop_notification(unit_id.as_str(), stop)
    }
}

#[cfg(test)]
mod tests {
    use chrono::{DateTime, TimeDelta};
    use unit_runner::UnitStatus;

    use super::*;

    const DOMAIN: &str = "ruth.relay.example.com";
    const OTHER_DOMAIN: &str = "lab.relay.example.com";

    const EVERY_PLATFORM_REASON: [PlatformStopReason; 10] = [
        PlatformStopReason::UserStop,
        PlatformStopReason::PlatformTimeout,
        PlatformStopReason::PlatformExpiration,
        PlatformStopReason::NativeNotificationStop,
        PlatformStopReason::OsRestart,
        PlatformStopReason::BootRecovery,
        PlatformStopReason::TaskCompleted,
        PlatformStopReason::Error,
        PlatformStopReason::ProcessExit,
        PlatformStopReason::Unknown,
    ];

    /// A stop for `reason` with `error`, the `nth` of its test, so no two
    /// stops of a test are equal.
    fn stop(reason: StopReason, error: Option<&str>, nth: i64) -> RunStop {
        RunStop {
            reason,
            error: error.map(str::to_owned),
            stopped_at: DateTime::from_timestamp(1_800_000_000, 0).expect("a valid instant")
                + TimeDelta::seconds(nth),
        }
    }

    fn failure(error: &str, nth: i64) -> RunStop {
        stop(StopReason::EndedOnItsOwn, Some(error), nth)
    }

    fn stopped(stop: RunStop) -> UnitStatus<()> {
        UnitStatus {
            run_state: RunState::Stopped {
                last_stop: Some(stop),
            },
            running_since: None,
            detail: None,
        }
    }

    fn running() -> UnitStatus<()> {
        UnitStatus {
            run_state: RunState::Running,
            running_since: Some(DateTime::from_timestamp(1_800_000_000, 0).expect("an instant")),
            detail: None,
        }
    }

    fn statuses(entries: Vec<(&str, UnitStatus<()>)>) -> UnitStatuses<()> {
        entries
            .into_iter()
            .map(|(domain, status)| (UnitId::from(domain), status))
            .collect()
    }

    #[test]
    fn the_unit_runner_s_own_stops_never_notify() {
        for reason in [
            StopReason::PolicyInactive,
            StopReason::Replaced,
            StopReason::Removed,
            StopReason::StoppedForRestart,
        ] {
            assert_eq!(
                stop_notification(DOMAIN, &stop(reason, None, 0)),
                None,
                "{reason:?}"
            );
        }
    }

    #[test]
    fn every_session_end_by_the_platform_notifies_under_the_server_s_id() {
        for platform_reason in EVERY_PLATFORM_REASON {
            let notification = stop_notification(
                DOMAIN,
                &stop(
                    StopReason::SessionEndedByPlatform { platform_reason },
                    None,
                    0,
                ),
            )
            .unwrap_or_else(|| panic!("{platform_reason:?} notifies"));
            assert_eq!(notification.id, "server-stopped:ruth.relay.example.com");
            assert!(
                notification.body.starts_with("ruth.relay.example.com: "),
                "{notification:?}"
            );
        }
    }

    #[test]
    fn a_platform_pause_says_which_platform_ended_it() {
        let ended_by_platform = stop(
            StopReason::SessionEndedByPlatform {
                platform_reason: PlatformStopReason::PlatformExpiration,
            },
            None,
            0,
        );
        assert_eq!(
            stop_notification(DOMAIN, &ended_by_platform),
            Some(LocalNotification {
                id: "server-stopped:ruth.relay.example.com".to_owned(),
                title: "Wildflower server paused".to_owned(),
                body: "ruth.relay.example.com: iOS ended the background window.".to_owned(),
            })
        );
    }

    #[test]
    fn a_failure_carries_its_error_and_a_clean_end_says_so() {
        assert_eq!(
            stop_notification(
                DOMAIN,
                &failure("failed to bind to 127.0.0.1:8080: Address already in use", 0)
            ),
            Some(LocalNotification {
                id: "server-stopped:ruth.relay.example.com".to_owned(),
                title: "Wildflower server stopped".to_owned(),
                body:
                    "ruth.relay.example.com: failed to bind to 127.0.0.1:8080: Address already in use"
                        .to_owned(),
            })
        );
        assert_eq!(
            stop_notification(DOMAIN, &stop(StopReason::EndedOnItsOwn, None, 0))
                .map(|notification| notification.body),
            Some("ruth.relay.example.com: The server stopped.".to_owned())
        );
    }

    #[test]
    fn each_stop_notifies_once() {
        let mut tracker = StopNotificationTracker::new();
        let ended_by_platform = stop(
            StopReason::SessionEndedByPlatform {
                platform_reason: PlatformStopReason::PlatformTimeout,
            },
            None,
            1,
        );
        let current = statuses(vec![(DOMAIN, stopped(ended_by_platform))]);
        assert_eq!(tracker.new_stop_notifications(&current).len(), 1);
        assert_eq!(tracker.new_stop_notifications(&current), Vec::new());
    }

    #[test]
    fn a_server_that_never_ran_or_is_running_notifies_nothing() {
        let mut tracker = StopNotificationTracker::new();
        let current = statuses(vec![
            (DOMAIN, UnitStatus::never_run()),
            (OTHER_DOMAIN, running()),
        ]);
        assert_eq!(tracker.new_stop_notifications(&current), Vec::new());
    }

    #[test]
    fn a_failure_repeating_on_every_retry_notifies_once_until_the_server_runs() {
        let mut tracker = StopNotificationTracker::new();
        let address_in_use = "failed to bind: Address already in use";
        let mut failed = |nth| {
            tracker
                .new_stop_notifications(&statuses(vec![(
                    DOMAIN,
                    stopped(failure(address_in_use, nth)),
                )]))
                .len()
        };
        assert_eq!(failed(1), 1);
        assert_eq!(failed(2), 0);
        assert_eq!(failed(3), 0);

        let disk_full = statuses(vec![(DOMAIN, stopped(failure("disk full", 4)))]);
        assert_eq!(tracker.new_stop_notifications(&disk_full).len(), 1);
        let address_in_use_again = statuses(vec![(DOMAIN, stopped(failure(address_in_use, 5)))]);
        assert_eq!(
            tracker.new_stop_notifications(&address_in_use_again).len(),
            1
        );

        tracker.new_stop_notifications(&statuses(vec![(DOMAIN, running())]));
        let after_running = statuses(vec![(DOMAIN, stopped(failure(address_in_use, 6)))]);
        assert_eq!(tracker.new_stop_notifications(&after_running).len(), 1);
    }

    #[test]
    fn servers_are_tracked_apart() {
        let mut tracker = StopNotificationTracker::new();
        let notifications = tracker.new_stop_notifications(&statuses(vec![
            (DOMAIN, stopped(failure("disk full", 1))),
            (OTHER_DOMAIN, stopped(failure("disk full", 1))),
        ]));
        let ids: Vec<&str> = notifications
            .iter()
            .map(|notification| notification.id.as_str())
            .collect();
        assert_eq!(
            ids,
            [
                "server-stopped:lab.relay.example.com",
                "server-stopped:ruth.relay.example.com"
            ]
        );
    }

    #[test]
    fn a_removed_server_is_forgotten() {
        let mut tracker = StopNotificationTracker::new();
        let failed = statuses(vec![(DOMAIN, stopped(failure("disk full", 1)))]);
        assert_eq!(tracker.new_stop_notifications(&failed).len(), 1);
        tracker.new_stop_notifications(&statuses(vec![]));
        assert_eq!(tracker.new_stop_notifications(&failed).len(), 1);
    }
}
