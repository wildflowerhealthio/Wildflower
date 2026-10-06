//! Noticing the running server becoming unreachable through its public origin,
//! and reachable again.

use wildflower_server_rust::ServerHealth;

use crate::domain::notification::LocalNotification;

/// The id both reach notifications share, so "reachable again" replaces
/// "unreachable".
pub const REACH_NOTIFICATION_ID: &str = "server-reach";

/// Follows the running server's [`ServerHealth`] and says when it becomes
/// unreachable and when it is reachable again.
///
/// A drop is the health going from `Reachable` to `Unreachable`. The health
/// going to `None` is not a drop: the server stopped, and the stop has its own
/// notification. After a drop, the next `Reachable` (in this run or a later
/// one) says the server is reachable again.
#[derive(Debug, Default)]
pub struct ReachDropDetector {
    reachable: bool,
    drop_announced: bool,
}

impl ReachDropDetector {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The notification the server's health moving to `server_health`
    /// warrants, if any.
    pub fn notification_for(
        &mut self,
        server_health: Option<&ServerHealth>,
    ) -> Option<LocalNotification> {
        let Some(server_health) = server_health else {
            self.reachable = false;
            return None;
        };
        match server_health {
            ServerHealth::Reachable(_) => {
                self.reachable = true;
                std::mem::take(&mut self.drop_announced).then(|| {
                    reach_notification(
                        "Server reachable again",
                        "Your apps can reach the server again.",
                    )
                })
            }
            ServerHealth::Unreachable { error } => {
                if !std::mem::take(&mut self.reachable) {
                    return None;
                }
                self.drop_announced = true;
                Some(reach_notification("Server unreachable", error))
            }
        }
    }
}

fn reach_notification(title: &str, body: &str) -> LocalNotification {
    LocalNotification {
        id: REACH_NOTIFICATION_ID.to_owned(),
        title: title.to_owned(),
        body: body.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use shared_structures_rust::health_check::{HealthReport, HealthStatus};

    fn reachable() -> ServerHealth {
        ServerHealth::Reachable(HealthReport::pass())
    }

    fn unreachable(error: &str) -> ServerHealth {
        ServerHealth::Unreachable {
            error: error.to_owned(),
        }
    }

    fn title_of(notification: Option<LocalNotification>) -> Option<String> {
        notification.map(|notification| notification.title)
    }

    #[test]
    fn a_drop_and_a_recovery_each_notify_once() {
        let mut detector = ReachDropDetector::new();
        assert_eq!(
            detector.notification_for(Some(&unreachable("connection refused"))),
            None,
            "not yet reached is not a drop"
        );
        assert_eq!(
            detector.notification_for(Some(&reachable())),
            None,
            "the first reach is not a recovery"
        );
        assert_eq!(
            detector.notification_for(Some(&unreachable("/health did not answer within 3s"))),
            Some(LocalNotification {
                id: REACH_NOTIFICATION_ID.to_owned(),
                title: "Server unreachable".to_owned(),
                body: "/health did not answer within 3s".to_owned(),
            })
        );
        assert_eq!(
            detector.notification_for(Some(&unreachable("connection refused"))),
            None,
            "a drop is announced once, not on every failed probe"
        );
        assert_eq!(
            detector.notification_for(Some(&reachable())),
            Some(LocalNotification {
                id: REACH_NOTIFICATION_ID.to_owned(),
                title: "Server reachable again".to_owned(),
                body: "Your apps can reach the server again.".to_owned(),
            })
        );
    }

    /// A server that answers `fail` is still reachable: no drop.
    #[test]
    fn a_failing_report_is_not_a_drop() {
        let mut detector = ReachDropDetector::new();
        detector.notification_for(Some(&reachable()));
        let failing = ServerHealth::Reachable(HealthReport {
            status: HealthStatus::Fail,
            ..HealthReport::pass()
        });
        assert_eq!(detector.notification_for(Some(&failing)), None);
    }

    #[test]
    fn the_server_stopping_is_not_a_drop_but_a_later_run_recovers() {
        let mut detector = ReachDropDetector::new();
        detector.notification_for(Some(&reachable()));
        assert_eq!(detector.notification_for(None), None);
        assert_eq!(
            detector.notification_for(Some(&unreachable("connection refused"))),
            None,
            "a new run not yet reached is not a drop"
        );

        detector.notification_for(Some(&reachable()));
        assert!(detector
            .notification_for(Some(&unreachable("connection refused")))
            .is_some());
        assert_eq!(detector.notification_for(None), None);
        assert_eq!(
            title_of(detector.notification_for(Some(&reachable()))),
            Some("Server reachable again".to_owned())
        );
    }

    /// One step of the server's health: stopped, reachable or unreachable.
    fn step() -> impl Strategy<Value = Option<bool>> {
        prop_oneof![Just(None), Just(Some(true)), Just(Some(false))]
    }

    proptest! {
        /// "Unreachable" only ever directly follows `Reachable`, "reachable
        /// again" only ever is `Reachable`, and the two strictly alternate,
        /// starting with a drop.
        #[test]
        fn drops_follow_reachable_and_alternate_with_recoveries(
            steps in proptest::collection::vec(step(), 0..40)
        ) {
            let mut detector = ReachDropDetector::new();
            let mut previous = None;
            let mut titles = Vec::new();
            for is_reachable in steps {
                let server_health = is_reachable.map(|is_reachable| {
                    if is_reachable { reachable() } else { unreachable("down") }
                });
                if let Some(notification) = detector.notification_for(server_health.as_ref()) {
                    if notification.title == "Server unreachable" {
                        prop_assert_eq!(previous, Some(true));
                    } else {
                        prop_assert_eq!(is_reachable, Some(true));
                    }
                    titles.push(notification.title);
                }
                previous = is_reachable;
            }
            for (index, title) in titles.iter().enumerate() {
                let expected = if index % 2 == 0 { "Server unreachable" } else { "Server reachable again" };
                prop_assert_eq!(title, expected);
            }
        }
    }
}
