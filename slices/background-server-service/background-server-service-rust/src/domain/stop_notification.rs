//! The notification for each stop of the server.

use crate::domain::notification::LocalNotification;
use crate::plugin_event::ServiceStopReason;

/// The id every stop notification shares, so a burst of stops replaces one
/// notification instead of stacking.
pub const SERVER_STOPPED_NOTIFICATION_ID: &str = "server-stopped";

/// The reason the host stops the service with itself, so that stop's
/// notification can be skipped: the stop half of a restart (from the page or
/// on a foreground resume), where the server comes straight back, and a stop
/// the base asked for, by changing a server's run policy or removing it, which
/// the base shows already.
///
/// The plugin never stops with this reason itself (its app-exit stop is a
/// `UserStop`, or `ProcessExit` on iOS).
pub const HOST_STOP_REASON: ServiceStopReason = ServiceStopReason::AppStop;

/// The notification for a run that stopped for `reason`, or `None` for a stop
/// the host made itself ([`HOST_STOP_REASON`]). Every other stop notifies.
#[must_use]
pub fn stop_notification(reason: ServiceStopReason) -> Option<LocalNotification> {
    let (title, body) = match reason {
        ServiceStopReason::AppStop => return None,
        ServiceStopReason::UserStop => ("Wildflower server stopped", "The server was stopped."),
        ServiceStopReason::NativeNotificationStop => (
            "Wildflower server stopped",
            "The server was stopped from its notification.",
        ),
        ServiceStopReason::TaskCompleted => ("Wildflower server stopped", "The server stopped."),
        ServiceStopReason::Error => (
            "Wildflower server stopped",
            "The server stopped after an error.",
        ),
        ServiceStopReason::PlatformTimeout => (
            "Wildflower server paused",
            "Android ended its background time.",
        ),
        ServiceStopReason::PlatformExpiration => (
            "Wildflower server paused",
            "iOS ended the background window.",
        ),
        ServiceStopReason::ProcessExit => (
            "Wildflower server paused",
            "The app was closed or put in the background.",
        ),
        ServiceStopReason::OsRestart => (
            "Wildflower server stopped",
            "The system restarted the service.",
        ),
        ServiceStopReason::BootRecovery => (
            "Wildflower server stopped",
            "The service stopped while recovering after a restart of the device.",
        ),
    };
    Some(stopped(title, body.to_owned()))
}

/// The notification for a run that failed with `error`.
#[must_use]
pub fn failure_notification(error: &str) -> LocalNotification {
    stopped("Wildflower server stopped", error.to_owned())
}

fn stopped(title: &str, body: String) -> LocalNotification {
    LocalNotification {
        id: SERVER_STOPPED_NOTIFICATION_ID.to_owned(),
        title: title.to_owned(),
        body,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EVERY_REASON: [ServiceStopReason; 10] = [
        ServiceStopReason::UserStop,
        ServiceStopReason::AppStop,
        ServiceStopReason::PlatformTimeout,
        ServiceStopReason::PlatformExpiration,
        ServiceStopReason::NativeNotificationStop,
        ServiceStopReason::OsRestart,
        ServiceStopReason::BootRecovery,
        ServiceStopReason::TaskCompleted,
        ServiceStopReason::Error,
        ServiceStopReason::ProcessExit,
    ];

    #[test]
    fn every_stop_notifies_except_the_host_s_own() {
        for reason in EVERY_REASON {
            let notification = stop_notification(reason);
            if reason == HOST_STOP_REASON {
                assert_eq!(notification, None, "a stop the host made must not notify");
            } else {
                let notification = notification.expect("every other stop notifies");
                assert_eq!(notification.id, SERVER_STOPPED_NOTIFICATION_ID);
                assert!(!notification.body.is_empty());
            }
        }
    }

    #[test]
    fn a_platform_pause_says_which_platform_ended_it() {
        assert_eq!(
            stop_notification(ServiceStopReason::PlatformExpiration),
            Some(LocalNotification {
                id: SERVER_STOPPED_NOTIFICATION_ID.to_owned(),
                title: "Wildflower server paused".to_owned(),
                body: "iOS ended the background window.".to_owned(),
            })
        );
    }

    #[test]
    fn a_failure_shares_the_stop_notification_and_carries_the_error() {
        assert_eq!(
            failure_notification("failed to bind to 127.0.0.1:8080: Address already in use"),
            LocalNotification {
                id: SERVER_STOPPED_NOTIFICATION_ID.to_owned(),
                title: "Wildflower server stopped".to_owned(),
                body: "failed to bind to 127.0.0.1:8080: Address already in use".to_owned(),
            }
        );
    }
}
