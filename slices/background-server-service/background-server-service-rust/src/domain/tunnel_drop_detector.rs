//! Noticing the tunnel dropping while the server runs, and coming back.

use shared_structures_rust::tunnel_service::{TunnelLiveness, TunnelStatus};

use crate::domain::notification::LocalNotification;

/// The id both tunnel notifications share, so "reconnected" replaces
/// "disconnected".
pub const TUNNEL_NOTIFICATION_ID: &str = "tunnel";

/// Follows the tunnel's liveness and says when it drops and when it comes back.
///
/// A drop is the tunnel leaving `Verified` for anything but `Off`. `Off` only
/// ever comes from a server wired without a tunnel, so it is not a drop.
/// Neither is the liveness going to `None`: the server stopped, and the stop
/// has its own notification. After a drop, the next `Verified` (in this run
/// or a later one) says the tunnel reconnected.
#[derive(Debug, Default)]
pub struct TunnelDropDetector {
    verified: bool,
    drop_announced: bool,
}

impl TunnelDropDetector {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The notification the tunnel moving to `liveness` warrants, if any.
    pub fn notification_for(
        &mut self,
        liveness: Option<&TunnelLiveness>,
    ) -> Option<LocalNotification> {
        let Some(liveness) = liveness else {
            self.verified = false;
            return None;
        };
        match liveness.status {
            TunnelStatus::Verified => {
                self.verified = true;
                std::mem::take(&mut self.drop_announced).then(|| {
                    tunnel_notification(
                        "Tunnel reconnected",
                        "Your apps can reach the server again.",
                    )
                })
            }
            TunnelStatus::Off => {
                self.verified = false;
                None
            }
            TunnelStatus::Dialing | TunnelStatus::Unreachable => {
                if !std::mem::take(&mut self.verified) {
                    return None;
                }
                self.drop_announced = true;
                Some(tunnel_notification(
                    "Tunnel disconnected",
                    liveness
                        .error
                        .as_deref()
                        .unwrap_or("Your apps can't reach the server; reconnecting."),
                ))
            }
        }
    }
}

fn tunnel_notification(title: &str, body: &str) -> LocalNotification {
    LocalNotification {
        id: TUNNEL_NOTIFICATION_ID.to_owned(),
        title: title.to_owned(),
        body: body.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn liveness(status: TunnelStatus, error: Option<&str>) -> TunnelLiveness {
        TunnelLiveness {
            status,
            origin: "https://demo.example.com".to_owned(),
            public_host: Some("demo.example.com".to_owned()),
            error: error.map(str::to_owned),
            dial_attempts: 1,
        }
    }

    fn title_of(notification: Option<LocalNotification>) -> Option<String> {
        notification.map(|notification| notification.title)
    }

    #[test]
    fn a_drop_and_a_recovery_each_notify_once() {
        let mut detector = TunnelDropDetector::new();
        assert_eq!(
            detector.notification_for(Some(&liveness(TunnelStatus::Dialing, None))),
            None
        );
        assert_eq!(
            detector.notification_for(Some(&liveness(TunnelStatus::Verified, None))),
            None,
            "the first verification is not a reconnection"
        );
        assert_eq!(
            detector.notification_for(Some(&liveness(
                TunnelStatus::Unreachable,
                Some("relay unreachable")
            ))),
            Some(LocalNotification {
                id: TUNNEL_NOTIFICATION_ID.to_owned(),
                title: "Tunnel disconnected".to_owned(),
                body: "relay unreachable".to_owned(),
            })
        );
        assert_eq!(
            detector.notification_for(Some(&liveness(TunnelStatus::Dialing, None))),
            None,
            "a drop is announced once, not on every retry"
        );
        assert_eq!(
            title_of(detector.notification_for(Some(&liveness(TunnelStatus::Verified, None)))),
            Some("Tunnel reconnected".to_owned())
        );
    }

    #[test]
    fn the_owner_turning_the_tunnel_off_is_not_a_drop() {
        let mut detector = TunnelDropDetector::new();
        detector.notification_for(Some(&liveness(TunnelStatus::Verified, None)));
        assert_eq!(
            detector.notification_for(Some(&liveness(TunnelStatus::Off, None))),
            None
        );
        assert_eq!(
            detector.notification_for(Some(&liveness(TunnelStatus::Verified, None))),
            None,
            "coming back from an owner's Off is not a reconnection"
        );
    }

    #[test]
    fn the_server_stopping_is_not_a_drop_but_a_later_run_reconnects() {
        let mut detector = TunnelDropDetector::new();
        detector.notification_for(Some(&liveness(TunnelStatus::Verified, None)));
        assert_eq!(detector.notification_for(None), None);

        detector.notification_for(Some(&liveness(TunnelStatus::Verified, None)));
        assert!(detector
            .notification_for(Some(&liveness(TunnelStatus::Unreachable, None)))
            .is_some());
        assert_eq!(detector.notification_for(None), None);
        assert_eq!(
            title_of(detector.notification_for(Some(&liveness(TunnelStatus::Verified, None)))),
            Some("Tunnel reconnected".to_owned())
        );
    }

    fn step() -> impl Strategy<Value = Option<TunnelStatus>> {
        prop_oneof![
            Just(None),
            Just(Some(TunnelStatus::Off)),
            Just(Some(TunnelStatus::Dialing)),
            Just(Some(TunnelStatus::Verified)),
            Just(Some(TunnelStatus::Unreachable)),
        ]
    }

    proptest! {
        /// "Disconnected" only ever directly follows `Verified`, and
        /// "disconnected" and "reconnected" strictly alternate, starting with a
        /// disconnection.
        #[test]
        fn drops_follow_verified_and_alternate_with_recoveries(
            steps in proptest::collection::vec(step(), 0..40)
        ) {
            let mut detector = TunnelDropDetector::new();
            let mut previous = None;
            let mut titles = Vec::new();
            for status in steps {
                let snapshot = status.map(|status| liveness(status, None));
                if let Some(notification) = detector.notification_for(snapshot.as_ref()) {
                    if notification.title == "Tunnel disconnected" {
                        prop_assert_eq!(previous, Some(TunnelStatus::Verified));
                    } else {
                        prop_assert_eq!(status, Some(TunnelStatus::Verified));
                    }
                    titles.push(notification.title);
                }
                previous = status;
            }
            for (index, title) in titles.iter().enumerate() {
                let expected = if index % 2 == 0 { "Tunnel disconnected" } else { "Tunnel reconnected" };
                prop_assert_eq!(title, expected);
            }
        }
    }
}
