//! The notifications for the consents waiting on the servers:
//! [`ConsentRequest`], what one notification says;
//! [`ConsentNotificationCoalescer`], which picks the requests that notify out
//! of `UnitRunner`'s statuses; and [`server_of_consent_notification`], the
//! server a tapped notification is for.

use std::collections::BTreeMap;

use wildflowerhealthio_unit_runner::{UnitId, UnitStatuses};

use crate::domain::notifications::local_notification::LocalNotification;
use crate::domain::{ConsentKey, PendingConsent, ServerDetail};

/// The start of a server's consent notification id, which its domain
/// completes, so a server's next request replaces its last one's notification
/// instead of stacking, and never another server's.
pub const CONSENT_REQUEST_NOTIFICATION_ID_PREFIX: &str = "consent-request:";

/// A consent that became the oldest waiting on the server `domain`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsentRequest {
    /// The server's domain, its unit id.
    pub domain: String,
    /// The consent waiting there.
    pub pending_consent: PendingConsent,
}

impl ConsentRequest {
    /// The notification for this request, under the server's own id
    /// (`consent-request:<domain>`): "‹client› wants access to ‹domain›". A
    /// tap opens the consent waiting on the server.
    #[must_use]
    pub fn notification(&self) -> LocalNotification {
        let domain = &self.domain;
        LocalNotification {
            title: "Access request".to_owned(),
            body: format!(
                "{} wants access to {domain}",
                self.pending_consent.client_name
            ),
            ..consent_notification_of(domain)
        }
    }
}

/// The server among `domains` whose consent notification is the one the
/// notification plugin posted under `plugin_id`
/// ([`LocalNotification::hash_id_for_plugin`]), as a tap on it reports it;
/// `None` for any other notification, such as a stop's.
///
/// A mobile platform reports a tap with the notification's plugin id, the one
/// thing about it every platform reports, so the server is found by hashing
/// each server's consent notification id the same way.
#[must_use]
pub fn server_of_consent_notification<'a>(
    plugin_id: i32,
    domains: impl IntoIterator<Item = &'a str>,
) -> Option<&'a str> {
    domains
        .into_iter()
        .find(|domain| consent_notification_of(domain).hash_id_for_plugin() == plugin_id)
}

/// The server `domain`'s consent notification, under its id, with no text.
fn consent_notification_of(domain: &str) -> LocalNotification {
    LocalNotification {
        id: format!("{CONSENT_REQUEST_NOTIFICATION_ID_PREFIX}{domain}"),
        title: String::new(),
        body: String::new(),
    }
}

/// Decides which of the servers' waiting consents notify, fed `UnitRunner`'s
/// statuses each time they change, whose unit ids are the servers' domains.
///
/// A server notifies when the head of its queue becomes a request it hasn't
/// notified for, once per request: a head already notified for doesn't notify
/// again, as when the server's run restarts with the same request waiting,
/// and the requests queued behind the head don't notify until they reach it.
/// A server that is removed is forgotten.
#[derive(Debug, Default)]
pub struct ConsentNotificationCoalescer {
    /// The key of the last request each server notified for.
    last_notified: BTreeMap<UnitId, ConsentKey>,
}

impl ConsentNotificationCoalescer {
    /// A coalescer that has notified for no request.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The requests in `statuses` that notify, in domain order.
    pub fn record(&mut self, statuses: &UnitStatuses<ServerDetail>) -> Vec<ConsentRequest> {
        self.last_notified
            .retain(|unit_id, _| statuses.contains_key(unit_id));
        statuses
            .iter()
            .filter_map(|(unit_id, unit_status)| {
                let pending_consent = PendingConsent::of_run(unit_status)?;
                if self.last_notified.get(unit_id) == Some(&pending_consent.key) {
                    return None;
                }
                self.last_notified
                    .insert(unit_id.clone(), pending_consent.key.clone());
                Some(ConsentRequest {
                    domain: unit_id.as_str().to_owned(),
                    pending_consent,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use wildflowerhealthio_authorization_server::PendingConsentHead;
    use wildflowerhealthio_unit_runner::{RunState, UnitStatus};

    use super::*;
    use crate::domain::server_status::tests::{LAB, RUTH};

    fn running_with(pending_consent: Option<PendingConsentHead>) -> UnitStatus<ServerDetail> {
        UnitStatus {
            run_state: RunState::Running,
            running_since: None,
            detail: Some(ServerDetail {
                health: None,
                tunnel: None,
                certificate: None,
                pending_consent,
                launch_minter: None,
                sign_in_code_minter: None,
            }),
        }
    }

    fn oauth(id: &str) -> PendingConsentHead {
        PendingConsentHead::OAuth {
            id: id.to_owned(),
            client_name: "Lifting".to_owned(),
        }
    }

    fn device(user_code: &str) -> PendingConsentHead {
        PendingConsentHead::Device {
            user_code: user_code.to_owned(),
            client_name: "Pebble".to_owned(),
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

    /// The domain and key of each request, to compare at a glance.
    fn summary(requests: &[ConsentRequest]) -> Vec<(&str, ConsentKey)> {
        requests
            .iter()
            .map(|request| (request.domain.as_str(), request.pending_consent.key.clone()))
            .collect()
    }

    fn oauth_key(id: &str) -> ConsentKey {
        ConsentKey::OAuth { id: id.to_owned() }
    }

    #[test]
    fn a_new_head_notifies_once() {
        let mut coalescer = ConsentNotificationCoalescer::new();
        let first = coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(None)),
        ]));
        assert_eq!(summary(&first), [(RUTH, oauth_key("a"))]);

        let again = coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(None)),
        ]));
        assert!(again.is_empty());
    }

    #[test]
    fn the_next_head_notifies_once_the_first_is_decided() {
        let mut coalescer = ConsentNotificationCoalescer::new();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));

        let next = coalescer.record(&statuses([(RUTH, running_with(Some(device("CODE"))))]));
        assert_eq!(
            summary(&next),
            [(
                RUTH,
                ConsentKey::Device {
                    user_code: "CODE".to_owned()
                }
            )]
        );
    }

    #[test]
    fn a_head_seen_before_a_restart_does_not_notify_again() {
        let mut coalescer = ConsentNotificationCoalescer::new();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        assert!(coalescer
            .record(&statuses([(RUTH, UnitStatus::never_run())]))
            .is_empty());

        let restarted = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        assert!(restarted.is_empty());
    }

    #[test]
    fn a_removed_server_is_forgotten() {
        let mut coalescer = ConsentNotificationCoalescer::new();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        coalescer.record(&statuses([]));

        let added_again = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        assert_eq!(summary(&added_again), [(RUTH, oauth_key("a"))]);
    }

    #[test]
    fn each_server_notifies_for_its_own_head() {
        let mut coalescer = ConsentNotificationCoalescer::new();
        let requests = coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(Some(oauth("a")))),
        ]));
        assert_eq!(
            summary(&requests),
            [(LAB, oauth_key("a")), (RUTH, oauth_key("a"))]
        );
    }

    #[test]
    fn the_notification_names_the_client_and_the_server_and_opens_the_consent() {
        let request = ConsentRequest {
            domain: RUTH.to_owned(),
            pending_consent: oauth("a").into(),
        };
        assert_eq!(
            request.notification(),
            LocalNotification {
                id: format!("consent-request:{RUTH}"),
                title: "Access request".to_owned(),
                body: format!("Lifting wants access to {RUTH}"),
            }
        );
    }

    #[test]
    fn a_tapped_consent_notification_names_its_server_and_no_other_does() {
        let posted = ConsentRequest {
            domain: LAB.to_owned(),
            pending_consent: oauth("a").into(),
        }
        .notification()
        .hash_id_for_plugin();
        assert_eq!(
            server_of_consent_notification(posted, [RUTH, LAB]),
            Some(LAB)
        );

        let stop = LocalNotification {
            id: format!("server-stopped:{LAB}"),
            title: String::new(),
            body: String::new(),
        };
        assert_eq!(
            server_of_consent_notification(stop.hash_id_for_plugin(), [RUTH, LAB]),
            None
        );
    }
}
