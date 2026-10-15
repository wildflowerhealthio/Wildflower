//! The notifications for the consents waiting on the servers:
//! [`ConsentRequest`], what one notification says;
//! [`ConsentNotificationCoalescer`], which picks the requests that notify out
//! of `UnitRunner`'s statuses; and [`server_of_consent_notification`], the
//! server a tapped notification is for.

use std::collections::{BTreeMap, VecDeque};

use wildflowerhealthio_unit_runner::{UnitId, UnitStatuses};

use crate::domain::notifications::local_notification::LocalNotification;
use crate::domain::{ConsentKey, PendingConsent, ServerDetail};

/// The start of a server's consent notification id, which its domain
/// completes, so a server's next request replaces its last one's notification
/// instead of stacking, and never another server's.
pub const CONSENT_REQUEST_NOTIFICATION_ID_PREFIX: &str = "consent-request:";

/// A consent that became the newest waiting on the server `domain`, and that
/// the server hasn't notified for.
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

/// How many of the requests it notified for a server remembers while some
/// request stays pending on it, past which it forgets the earliest.
///
/// A request lives five minutes, so a server forgets one it notified for only
/// after this many newer requests in that time; the forgotten one notifies
/// again only if it is still pending once every one of those is decided.
const NOTIFIED_PER_SERVER: usize = 32;

/// Decides which of the servers' waiting consents notify, fed `UnitRunner`'s
/// statuses each time they change, whose unit ids are the servers' domains.
///
/// A server's status carries its newest pending request, so its requests
/// stack: a new one takes over, and deciding it brings back the one before.
/// A server notifies once per request, when that request is newest and the
/// server hasn't notified for it: a request that comes back once a newer one
/// is decided doesn't notify again, nor does one still waiting when the
/// server's run restarts.
///
/// A server remembers the requests it notified for until its run reports
/// nothing pending, since then each of them is decided or expired and none
/// can come back, keeping at most [`NOTIFIED_PER_SERVER`] meanwhile. A run
/// that isn't reporting, as while it stops or starts, leaves them as they
/// are. A server that is removed is forgotten.
#[derive(Debug, Default)]
pub struct ConsentNotificationCoalescer {
    /// The keys of the requests each server notified for, earliest first.
    notified: BTreeMap<UnitId, VecDeque<ConsentKey>>,
}

impl ConsentNotificationCoalescer {
    /// A coalescer that has notified for no request.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The requests in `statuses` that notify, in domain order.
    pub fn record(&mut self, statuses: &UnitStatuses<ServerDetail>) -> Vec<ConsentRequest> {
        self.notified
            .retain(|unit_id, _| statuses.contains_key(unit_id));
        statuses
            .iter()
            .filter_map(|(unit_id, unit_status)| {
                let detail = unit_status.detail.as_ref()?;
                let Some(newest) = detail.pending_consent.clone() else {
                    self.notified.remove(unit_id);
                    return None;
                };
                let pending_consent = PendingConsent::from(newest);
                let notified = self.notified.entry(unit_id.clone()).or_default();
                if notified.contains(&pending_consent.key) {
                    return None;
                }
                if notified.len() == NOTIFIED_PER_SERVER {
                    notified.pop_front();
                }
                notified.push_back(pending_consent.key.clone());
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
    use wildflowerhealthio_authorization_server::NewestPendingConsent;
    use wildflowerhealthio_unit_runner::{RunState, UnitStatus};

    use super::*;
    use crate::domain::server_status::tests::{LAB, RUTH};

    fn running_with(pending_consent: Option<NewestPendingConsent>) -> UnitStatus<ServerDetail> {
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

    fn oauth(id: &str) -> NewestPendingConsent {
        NewestPendingConsent::OAuth {
            id: id.to_owned(),
            client_name: "Lifting".to_owned(),
        }
    }

    fn device(user_code: &str) -> NewestPendingConsent {
        NewestPendingConsent::Device {
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

    fn device_key(user_code: &str) -> ConsentKey {
        ConsentKey::Device {
            user_code: user_code.to_owned(),
        }
    }

    #[test]
    fn a_new_request_notifies_once() {
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
    fn a_newer_request_notifies_while_the_earlier_one_waits() {
        let mut coalescer = ConsentNotificationCoalescer::new();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));

        let newer = coalescer.record(&statuses([(RUTH, running_with(Some(device("CODE"))))]));
        assert_eq!(summary(&newer), [(RUTH, device_key("CODE"))]);
    }

    #[test]
    fn a_request_that_comes_back_once_a_newer_one_is_decided_does_not_notify_again() {
        let mut coalescer = ConsentNotificationCoalescer::new();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("b"))))]));

        let back = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        assert!(back.is_empty());
    }

    #[test]
    fn a_request_never_newest_before_notifies_when_it_comes_back() {
        let mut coalescer = ConsentNotificationCoalescer::new();
        // "a" was requested first, but "b" came before the server reported.
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("b"))))]));

        let back = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        assert_eq!(summary(&back), [(RUTH, oauth_key("a"))]);
    }

    #[test]
    fn a_request_seen_before_a_restart_does_not_notify_again() {
        let mut coalescer = ConsentNotificationCoalescer::new();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        assert!(coalescer
            .record(&statuses([(RUTH, UnitStatus::never_run())]))
            .is_empty());

        let restarted = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        assert!(restarted.is_empty());
    }

    #[test]
    fn nothing_pending_forgets_the_requests_notified_for() {
        let mut coalescer = ConsentNotificationCoalescer::new();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        coalescer.record(&statuses([(RUTH, running_with(None))]));

        // A decided or expired request never comes back; this one stands in
        // to show the server forgot it.
        let again = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        assert_eq!(summary(&again), [(RUTH, oauth_key("a"))]);
    }

    #[test]
    fn a_server_forgets_its_earliest_request_past_its_limit() {
        let mut coalescer = ConsentNotificationCoalescer::new();
        for index in 0..=NOTIFIED_PER_SERVER {
            coalescer.record(&statuses([(
                RUTH,
                running_with(Some(oauth(&index.to_string()))),
            )]));
        }

        let kept = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("1"))))]));
        assert!(kept.is_empty());
        let forgotten = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("0"))))]));
        assert_eq!(summary(&forgotten), [(RUTH, oauth_key("0"))]);
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
    fn each_server_notifies_for_its_own_request() {
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
