//! The notifications for the servers' stopped runs: [`StopCause`], why a run
//! stopped among the stops that notify, [`ServerStop`], what one
//! notification says, and [`StopNotificationCoalescer`], which keeps a
//! server's failure from notifying again on every retry.

use std::collections::BTreeMap;

use unit_runner_rust::{PlatformStopReason, RunStop, RunStopped, StopReason, UnitId};

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

/// Why a server's run stopped, among the stops that notify.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopCause {
    /// The run ended on its own with this error.
    Failed(String),
    /// The run ended on its own without an error.
    Ended,
    /// The platform ended the background session, for this reason.
    EndedByPlatform(PlatformStopReason),
}

impl StopCause {
    /// The cause of `stop`, or `None` for a stop `UnitRunner` made itself:
    /// the app set the server again or removed it, its policy stopped wanting
    /// it running, or `UnitRunner` restarted it. Those don't notify.
    #[must_use]
    pub fn from_run_stop(stop: RunStop) -> Option<Self> {
        match stop.reason {
            StopReason::PolicyInactive
            | StopReason::Replaced
            | StopReason::Removed
            | StopReason::StoppedForRestart => None,
            StopReason::EndedOnItsOwn => Some(match stop.error {
                Some(error) => Self::Failed(error),
                None => Self::Ended,
            }),
            StopReason::SessionEndedByPlatform { platform_reason } => {
                Some(Self::EndedByPlatform(platform_reason))
            }
        }
    }
}

/// What one stop notification says: the server `domain`'s run stopped, for
/// `cause`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerStop {
    /// The server's domain, its unit id.
    pub domain: String,
    /// Why its run stopped.
    pub cause: StopCause,
}

impl ServerStop {
    /// The notification for this stop, under the server's own id
    /// (`server-stopped:<domain>`), with its body starting with the domain.
    #[must_use]
    pub fn notification(&self) -> LocalNotification {
        let (title, text) = match &self.cause {
            StopCause::Failed(error) => (STOPPED_TITLE, error.as_str()),
            StopCause::Ended => (STOPPED_TITLE, "The server stopped."),
            StopCause::EndedByPlatform(platform_reason) => session_end_text(*platform_reason),
        };
        let domain = &self.domain;
        LocalNotification {
            id: format!("{SERVER_STOPPED_NOTIFICATION_ID_PREFIX}{domain}"),
            title: title.to_owned(),
            body: format!("{domain}: {text}"),
        }
    }
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

/// Decides which of the servers' stops notify, fed each stop `UnitRunner`
/// reports once ([`RunStopped`]), whose unit ids are the servers' domains.
///
/// A stop notifies when it has a [`StopCause`], with one more rule:
/// `UnitRunner` retries a failed run every few seconds, so a failure with the
/// same error as the stop last notified for that server doesn't notify again
/// until the server has run or the app has set it again (a new token, say) or
/// removed it.
#[derive(Debug, Default)]
pub struct StopNotificationCoalescer {
    /// The cause of each server's stop last notified, until the server runs
    /// again, is set again or removed.
    last_notified: BTreeMap<UnitId, StopCause>,
}

impl StopNotificationCoalescer {
    /// A coalescer that has notified no failures.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Take in `stopped`, returning the notification it warrants, if any:
    /// `None` when it doesn't notify or repeats the failure last notified for
    /// its server.
    pub fn record(&mut self, stopped: RunStopped) -> Option<ServerStop> {
        let RunStopped {
            unit_id,
            stop,
            announced_running,
        } = stopped;
        if announced_running || matches!(stop.reason, StopReason::Replaced | StopReason::Removed) {
            self.last_notified.remove(&unit_id);
        }
        let cause = StopCause::from_run_stop(stop)?;
        if matches!(cause, StopCause::Failed(_)) && self.last_notified.get(&unit_id) == Some(&cause)
        {
            return None;
        }
        let domain = unit_id.as_str().to_owned();
        self.last_notified.insert(unit_id, cause.clone());
        Some(ServerStop { domain, cause })
    }
}

#[cfg(test)]
mod tests {
    use chrono::{DateTime, TimeDelta};

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

    /// A stop for `reason` with `error`, `nth` seconds into its test.
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

    /// What the stop of `DOMAIN`'s run for `cause` says.
    fn stop_saying(cause: StopCause) -> LocalNotification {
        ServerStop {
            domain: DOMAIN.to_owned(),
            cause,
        }
        .notification()
    }

    #[test]
    fn the_unit_runner_s_own_stops_have_no_cause() {
        for reason in [
            StopReason::PolicyInactive,
            StopReason::Replaced,
            StopReason::Removed,
            StopReason::StoppedForRestart,
        ] {
            for error in [None, Some("disk full")] {
                assert_eq!(
                    StopCause::from_run_stop(stop(reason, error, 0)),
                    None,
                    "{reason:?} {error:?}"
                );
            }
        }
    }

    #[test]
    fn a_run_that_ended_on_its_own_failed_with_its_error_or_ended() {
        assert_eq!(
            StopCause::from_run_stop(failure("disk full", 0)),
            Some(StopCause::Failed("disk full".to_owned()))
        );
        assert_eq!(
            StopCause::from_run_stop(stop(StopReason::EndedOnItsOwn, None, 0)),
            Some(StopCause::Ended)
        );
    }

    #[test]
    fn a_session_end_by_the_platform_keeps_the_platform_s_reason() {
        for platform_reason in EVERY_PLATFORM_REASON {
            assert_eq!(
                StopCause::from_run_stop(stop(
                    StopReason::SessionEndedByPlatform { platform_reason },
                    None,
                    0,
                )),
                Some(StopCause::EndedByPlatform(platform_reason))
            );
        }
    }

    #[test]
    fn every_session_end_by_the_platform_notifies_under_the_server_s_id() {
        for platform_reason in EVERY_PLATFORM_REASON {
            let notification = stop_saying(StopCause::EndedByPlatform(platform_reason));
            assert_eq!(notification.id, "server-stopped:ruth.relay.example.com");
            assert!(
                notification.body.starts_with("ruth.relay.example.com: "),
                "{notification:?}"
            );
        }
    }

    #[test]
    fn a_platform_pause_says_which_platform_ended_it() {
        assert_eq!(
            stop_saying(StopCause::EndedByPlatform(
                PlatformStopReason::PlatformExpiration
            )),
            LocalNotification {
                id: "server-stopped:ruth.relay.example.com".to_owned(),
                title: "Wildflower server paused".to_owned(),
                body: "ruth.relay.example.com: iOS ended the background window.".to_owned(),
            }
        );
    }

    #[test]
    fn a_failure_carries_its_error_and_a_clean_end_says_so() {
        assert_eq!(
            stop_saying(StopCause::Failed(
                "failed to bind to 127.0.0.1:8080: Address already in use".to_owned()
            )),
            LocalNotification {
                id: "server-stopped:ruth.relay.example.com".to_owned(),
                title: "Wildflower server stopped".to_owned(),
                body:
                    "ruth.relay.example.com: failed to bind to 127.0.0.1:8080: Address already in use"
                        .to_owned(),
            }
        );
        assert_eq!(
            stop_saying(StopCause::Ended).body,
            "ruth.relay.example.com: The server stopped."
        );
    }

    /// `stopped` as `UnitRunner` reports it for `domain`, from a run that
    /// had (`ran`) or hadn't announced running.
    fn stopped(domain: &str, stop: RunStop, ran: bool) -> RunStopped {
        RunStopped {
            unit_id: UnitId::from(domain),
            stop,
            announced_running: ran,
        }
    }

    /// How many notifications `coalescer` posts for `stops`, fed in order.
    fn notified(coalescer: &mut StopNotificationCoalescer, stops: &[RunStopped]) -> usize {
        stops
            .iter()
            .filter_map(|stopped| coalescer.record(stopped.clone()))
            .count()
    }

    #[test]
    fn a_failure_repeating_on_every_retry_notifies_once_until_the_server_runs() {
        let mut coalescer = StopNotificationCoalescer::new();
        let address_in_use = "failed to bind: Address already in use";
        let retry = stopped(DOMAIN, failure(address_in_use, 1), false);
        assert_eq!(
            notified(&mut coalescer, &[retry.clone(), retry.clone(), retry]),
            1
        );

        let disk_full = stopped(DOMAIN, failure("disk full", 2), false);
        assert_eq!(notified(&mut coalescer, &[disk_full]), 1);
        let address_in_use_again = stopped(DOMAIN, failure(address_in_use, 3), false);
        assert_eq!(notified(&mut coalescer, &[address_in_use_again]), 1);

        let after_running = stopped(DOMAIN, failure(address_in_use, 4), true);
        assert_eq!(notified(&mut coalescer, &[after_running]), 1);
    }

    #[test]
    fn a_failure_notifies_again_after_the_app_replaced_or_removed_the_server() {
        let address_in_use = "failed to bind: Address already in use";
        for reason in [StopReason::Replaced, StopReason::Removed] {
            let mut coalescer = StopNotificationCoalescer::new();
            let failed = stopped(DOMAIN, failure(address_in_use, 1), false);
            assert_eq!(notified(&mut coalescer, std::slice::from_ref(&failed)), 1);
            let set_again = stopped(DOMAIN, stop(reason, None, 2), false);
            assert_eq!(notified(&mut coalescer, &[set_again]), 0, "{reason:?}");
            assert_eq!(notified(&mut coalescer, &[failed]), 1, "{reason:?}");
        }
    }

    #[test]
    fn a_failure_notifies_again_after_another_stop_of_its_server_notified() {
        let address_in_use = "failed to bind: Address already in use";
        let paused = stop(
            StopReason::SessionEndedByPlatform {
                platform_reason: PlatformStopReason::PlatformExpiration,
            },
            None,
            2,
        );
        for other_stop in [paused, stop(StopReason::EndedOnItsOwn, None, 2)] {
            let mut coalescer = StopNotificationCoalescer::new();
            let failed = stopped(DOMAIN, failure(address_in_use, 1), false);
            assert_eq!(notified(&mut coalescer, std::slice::from_ref(&failed)), 1);
            let other = stopped(DOMAIN, other_stop.clone(), false);
            assert_eq!(notified(&mut coalescer, &[other]), 1);
            assert_eq!(notified(&mut coalescer, &[failed]), 1, "{other_stop:?}");
        }
    }

    #[test]
    fn another_server_s_stop_leaves_a_failure_coalesced() {
        let address_in_use = "failed to bind: Address already in use";
        let mut coalescer = StopNotificationCoalescer::new();
        let failed = stopped(DOMAIN, failure(address_in_use, 1), false);
        assert_eq!(notified(&mut coalescer, std::slice::from_ref(&failed)), 1);
        let other_ended = stopped(OTHER_DOMAIN, stop(StopReason::EndedOnItsOwn, None, 2), true);
        let other_removed = stopped(OTHER_DOMAIN, stop(StopReason::Removed, None, 3), false);
        assert_eq!(notified(&mut coalescer, &[other_ended, other_removed]), 1);
        assert_eq!(notified(&mut coalescer, &[failed]), 0);
    }

    #[test]
    fn a_failure_still_coalesces_across_the_unit_runner_s_own_stops() {
        let address_in_use = "failed to bind: Address already in use";
        for reason in [StopReason::PolicyInactive, StopReason::StoppedForRestart] {
            let mut coalescer = StopNotificationCoalescer::new();
            let failed = stopped(DOMAIN, failure(address_in_use, 1), false);
            assert_eq!(notified(&mut coalescer, std::slice::from_ref(&failed)), 1);
            let own_stop = stopped(DOMAIN, stop(reason, None, 2), false);
            assert_eq!(notified(&mut coalescer, &[own_stop]), 0, "{reason:?}");
            assert_eq!(notified(&mut coalescer, &[failed]), 0, "{reason:?}");
        }
    }

    #[test]
    fn a_recorded_stop_names_its_server_and_cause() {
        let mut coalescer = StopNotificationCoalescer::new();
        assert_eq!(
            coalescer.record(stopped(DOMAIN, failure("disk full", 1), false)),
            Some(ServerStop {
                domain: DOMAIN.to_owned(),
                cause: StopCause::Failed("disk full".to_owned()),
            })
        );
    }

    #[test]
    fn servers_are_coalesced_apart() {
        let mut coalescer = StopNotificationCoalescer::new();
        let ids: Vec<String> = [DOMAIN, OTHER_DOMAIN]
            .into_iter()
            .filter_map(|domain| coalescer.record(stopped(domain, failure("disk full", 1), false)))
            .map(|server_stop| server_stop.notification().id)
            .collect();
        assert_eq!(
            ids,
            [
                "server-stopped:ruth.relay.example.com",
                "server-stopped:lab.relay.example.com"
            ]
        );
    }
}
