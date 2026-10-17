//! What the consent notifications offer beyond a tap, and what an action on
//! one acts on: [`OngoingConsentNotification`], the notification that stays
//! on Android while a request is pending; the ids of the actions a consent
//! notification offers ([`OPEN_CONSENT_ACTION_ID`],
//! [`DENY_CONSENT_ACTION_ID`]); and [`AnnouncedConsents`], the request each
//! notification posted names, which an action on it opens or denies.

use crate::domain::notifications::consent_notifications::{
    consent_notification_id_for_plugin, ConsentRequest,
};
use crate::domain::notifications::local_notification::LocalNotification;

/// The id of the ongoing consent notification, one for every server.
pub const ONGOING_CONSENT_NOTIFICATION_ID: &str = "consent-requests-pending";

/// The id the notification plugin reports for the Open action of a consent
/// notification, as the golden file pins it for the base.
pub const OPEN_CONSENT_ACTION_ID: &str = "open";

/// The id the notification plugin reports for the Deny action of a consent
/// notification, as the golden file pins it for the base.
pub const DENY_CONSENT_ACTION_ID: &str = "deny";

/// The notification that stays while a request is pending on any server, on
/// Android, where a request's own notification can be dismissed: it names the
/// newest request, which its Open and Deny act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OngoingConsentNotification {
    /// The request it names: of the requests still each server's newest, the
    /// one seen latest.
    pub newest: ConsentRequest,
    /// How many servers have a request it counts waiting.
    pub waiting_server_count: usize,
}

impl OngoingConsentNotification {
    /// The notification, under [`ONGOING_CONSENT_NOTIFICATION_ID`]: "Access
    /// request waiting", or how many servers have one, over "‹client› wants
    /// access to ‹domain›" for the request it names.
    #[must_use]
    pub fn notification(&self) -> LocalNotification {
        let title = if self.waiting_server_count == 1 {
            "Access request waiting".to_owned()
        } else {
            format!(
                "Access requests waiting on {} servers",
                self.waiting_server_count
            )
        };
        LocalNotification {
            title,
            body: self.newest.notification().body,
            ..ongoing_consent_notification_of()
        }
    }
}

/// The plugin id the ongoing consent notification is posted under
/// ([`LocalNotification::hash_id_for_plugin`]), to withdraw it by.
#[must_use]
pub fn ongoing_consent_notification_id_for_plugin() -> i32 {
    ongoing_consent_notification_of().hash_id_for_plugin()
}

/// The ongoing consent notification, under its id, with no text.
fn ongoing_consent_notification_of() -> LocalNotification {
    LocalNotification {
        id: ONGOING_CONSENT_NOTIFICATION_ID.to_owned(),
        title: String::new(),
        body: String::new(),
    }
}

/// The requests the consent notifications posted name: each server's own
/// notification's, and the ongoing notification's, so an action on one acts
/// on the request it named, and not on one that came since.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AnnouncedConsents {
    /// The request each server's notification announces, in domain order.
    pub by_server: Vec<ConsentRequest>,
    /// The request the ongoing notification names, while one is pending.
    pub ongoing: Option<ConsentRequest>,
}

impl AnnouncedConsents {
    /// The request the notification the plugin posted under `plugin_id`
    /// names, as an action on it reports it; `None` for one that names none,
    /// such as a stop's, or a server's whose notification was withdrawn.
    #[must_use]
    pub fn request_of_notification(&self, plugin_id: i32) -> Option<&ConsentRequest> {
        if plugin_id == ongoing_consent_notification_id_for_plugin() {
            return self.ongoing.as_ref();
        }
        self.by_server
            .iter()
            .find(|request| consent_notification_id_for_plugin(&request.domain) == plugin_id)
    }
}

#[cfg(test)]
mod tests {
    use wildflowerhealthio_authorization_server::NewestPendingConsent;

    use super::*;
    use crate::domain::golden;
    use crate::domain::server_status::tests::{LAB, RUTH};

    fn request(domain: &str, id: &str) -> ConsentRequest {
        ConsentRequest {
            domain: domain.to_owned(),
            pending_consent: NewestPendingConsent::OAuth {
                id: id.to_owned(),
                client_name: "Lifting".to_owned(),
                decidable_in_requesting_browser: false,
            }
            .into(),
        }
    }

    #[test]
    fn the_ongoing_notification_names_the_newest_request_and_counts_the_servers() {
        let one = OngoingConsentNotification {
            newest: request(RUTH, "a"),
            waiting_server_count: 1,
        };
        assert_eq!(
            one.notification(),
            LocalNotification {
                id: "consent-requests-pending".to_owned(),
                title: "Access request waiting".to_owned(),
                body: format!("Lifting wants access to {RUTH}"),
            }
        );
        let two = OngoingConsentNotification {
            waiting_server_count: 2,
            ..one
        };
        assert_eq!(
            two.notification().title,
            "Access requests waiting on 2 servers"
        );
    }

    #[test]
    fn an_action_acts_on_the_request_its_notification_named() {
        let announced = AnnouncedConsents {
            by_server: vec![request(LAB, "b"), request(RUTH, "a")],
            ongoing: Some(request(LAB, "b")),
        };
        assert_eq!(
            announced.request_of_notification(consent_notification_id_for_plugin(RUTH)),
            Some(&request(RUTH, "a"))
        );
        assert_eq!(
            announced.request_of_notification(ongoing_consent_notification_id_for_plugin()),
            Some(&request(LAB, "b"))
        );
        let stop = LocalNotification {
            id: format!("server-stopped:{RUTH}"),
            title: String::new(),
            body: String::new(),
        };
        assert_eq!(
            announced.request_of_notification(stop.hash_id_for_plugin()),
            None
        );
        assert_eq!(
            AnnouncedConsents::default()
                .request_of_notification(consent_notification_id_for_plugin(RUTH)),
            None,
            "a withdrawn notification names nothing"
        );
    }

    #[test]
    fn the_action_ids_are_as_the_golden_file_says() {
        assert_eq!(
            golden()["consentNotificationActions"],
            serde_json::json!({
                "open": OPEN_CONSENT_ACTION_ID,
                "deny": DENY_CONSENT_ACTION_ID,
            })
        );
    }
}
