//! The notifications for the consents waiting on the servers:
//! [`ConsentRequest`], what one notification says;
//! [`ConsentNotificationCoalescer`], which picks the requests that notify, and
//! the servers whose notification is withdrawn, out of `UnitRunner`'s
//! statuses; and [`server_of_consent_notification`], the server a tapped
//! notification is for, by [`consent_notification_id_for_plugin`].

use std::collections::{BTreeMap, BTreeSet, VecDeque};

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
        .find(|domain| consent_notification_id_for_plugin(domain) == plugin_id)
}

/// The plugin id the server `domain`'s consent notification is posted under
/// ([`LocalNotification::hash_id_for_plugin`]), to withdraw it by.
#[must_use]
pub fn consent_notification_id_for_plugin(domain: &str) -> i32 {
    consent_notification_of(domain).hash_id_for_plugin()
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
/// A request the Owner's own browser made (`requested_by_owner_browser`)
/// never notifies: that browser already shows its consent card. It still
/// counts as the server's newest, so it withdraws the server's notification
/// for an older one, and counts as notified for, so it doesn't notify when it
/// comes back either.
///
/// A server's notification stays while the request it announced is the
/// server's newest; once another that notified before is newest, or nothing
/// is pending, the server's notification is withdrawn, so it never announces
/// a request decided or expired. A server that is removed has it withdrawn
/// too.
///
/// Which requests open, as [`ConsentOpening`] says: on the desktop each
/// one that notifies; on a phone the first fresh request a server reports at
/// the app's start, which opens instead of notifying.
///
/// A server remembers the requests it notified for until its run reports
/// nothing pending, since then each of them is decided or expired and none
/// can come back, keeping at most [`NOTIFIED_PER_SERVER`] meanwhile. A run
/// that isn't reporting, as while it stops or starts, leaves them, and its
/// notification, as they are. A server that is removed is forgotten.
///
/// The servers it remembers requests for are the ones with a request
/// pending, as their run last reported:
/// [`pending_server_count`](Self::pending_server_count), what the app icon's
/// badge shows.
#[derive(Debug)]
pub struct ConsentNotificationCoalescer {
    /// Which requests open.
    opening: ConsentOpening,
    /// The servers whose run has reported since the app started.
    reported: BTreeSet<UnitId>,
    /// Whether a request opened at the app's start already
    /// ([`ConsentOpening::FirstAtStart`]).
    opened_at_start: bool,
    /// The keys of the requests each server notified for, or opened, earliest
    /// first, for each server with a request pending as its run last
    /// reported.
    notified: BTreeMap<UnitId, VecDeque<ConsentKey>>,
    /// The key of the request each server's notification announces, for each
    /// server with one posted and not withdrawn.
    announced: BTreeMap<UnitId, ConsentKey>,
}

/// Which consent requests open, besides notifying.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsentOpening {
    /// Each request that notifies opens too, as on the desktop, which can't
    /// click a notification.
    AsNotified,
    /// A tap on a notification opens its request, as on a phone; and the
    /// first fresh request a server reports at the app's start opens instead
    /// of notifying, once for the app's start: the first server's in domain
    /// order, while a request on any other server notifies.
    FirstAtStart,
}

/// What a [`ConsentNotificationCoalescer`] decided from one set of statuses.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ConsentNotificationChanges {
    /// The requests that notify, in domain order.
    pub posted: Vec<ConsentRequest>,
    /// The requests that open, in domain order: each posted one under
    /// [`ConsentOpening::AsNotified`], or the one opened at the app's start
    /// under [`ConsentOpening::FirstAtStart`].
    pub opened: Vec<ConsentRequest>,
    /// The domains of the servers whose consent notification is withdrawn,
    /// in domain order (see [`consent_notification_id_for_plugin`]).
    pub withdrawn: Vec<String>,
}

impl ConsentNotificationCoalescer {
    /// A coalescer that has notified for no request, and opens requests as
    /// `opening` says.
    #[must_use]
    pub fn new(opening: ConsentOpening) -> Self {
        Self {
            opening,
            reported: BTreeSet::new(),
            opened_at_start: false,
            notified: BTreeMap::new(),
            announced: BTreeMap::new(),
        }
    }

    /// The requests in `statuses` that notify or open, and the servers whose
    /// notification is withdrawn.
    pub fn record(&mut self, statuses: &UnitStatuses<ServerDetail>) -> ConsentNotificationChanges {
        let mut changes = ConsentNotificationChanges::default();
        self.notified
            .retain(|unit_id, _| statuses.contains_key(unit_id));
        self.announced.retain(|unit_id, _| {
            let kept = statuses.contains_key(unit_id);
            if !kept {
                changes.withdrawn.push(unit_id.as_str().to_owned());
            }
            kept
        });
        for (unit_id, unit_status) in statuses {
            let Some(detail) = unit_status.detail.as_ref() else {
                continue;
            };
            let first_report = self.reported.insert(unit_id.clone());
            let Some(newest) = detail.pending_consent.clone() else {
                self.notified.remove(unit_id);
                if self.announced.remove(unit_id).is_some() {
                    changes.withdrawn.push(unit_id.as_str().to_owned());
                }
                continue;
            };
            let pending_consent = PendingConsent::from(newest);
            let notified = self.notified.entry(unit_id.clone()).or_default();
            if notified.contains(&pending_consent.key) {
                if self
                    .announced
                    .get(unit_id)
                    .is_some_and(|announced| *announced != pending_consent.key)
                {
                    self.announced.remove(unit_id);
                    changes.withdrawn.push(unit_id.as_str().to_owned());
                }
                continue;
            }
            if notified.len() == NOTIFIED_PER_SERVER {
                notified.pop_front();
            }
            notified.push_back(pending_consent.key.clone());
            if pending_consent.requested_by_owner_browser {
                if self.announced.remove(unit_id).is_some() {
                    changes.withdrawn.push(unit_id.as_str().to_owned());
                }
                continue;
            }
            let request = ConsentRequest {
                domain: unit_id.as_str().to_owned(),
                pending_consent,
            };
            if self.opening == ConsentOpening::FirstAtStart && first_report && !self.opened_at_start
            {
                self.opened_at_start = true;
                changes.opened.push(request);
                continue;
            }
            self.announced
                .insert(unit_id.clone(), request.pending_consent.key.clone());
            if self.opening == ConsentOpening::AsNotified {
                changes.opened.push(request.clone());
            }
            changes.posted.push(request);
        }
        changes.withdrawn.sort();
        changes
    }

    /// How many servers have a request pending, as their run last reported
    /// to [`record`](Self::record): what the app icon's badge shows.
    ///
    /// A server counts from its run's report of a pending request until its
    /// run reports nothing pending or it is removed, when its notification is
    /// withdrawn too. A run that isn't reporting, as while it stops or
    /// starts, keeps its server counted, as it keeps the server's
    /// notification posted. A server counts once however many requests wait
    /// on it, and a request that didn't notify counts all the same: one the
    /// Owner's own browser made, one opened at the app's start, or one that
    /// came back once a newer one was decided.
    #[must_use]
    pub fn pending_server_count(&self) -> usize {
        self.notified.len()
    }
}

#[cfg(test)]
mod tests {
    use wildflowerhealthio_authorization_server::NewestPendingConsent;
    use wildflowerhealthio_unit_runner::{RunState, UnitStatus};

    use super::*;
    use crate::domain::server_status::tests::{statuses, LAB, RUTH};

    /// A phone's coalescer whose one open at the app's start is spent, so it
    /// only notifies.
    fn notifying() -> ConsentNotificationCoalescer {
        let mut coalescer = ConsentNotificationCoalescer::new(ConsentOpening::FirstAtStart);
        coalescer.opened_at_start = true;
        coalescer
    }

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
                consent_watcher: None,
            }),
        }
    }

    fn oauth(id: &str) -> NewestPendingConsent {
        NewestPendingConsent::OAuth {
            id: id.to_owned(),
            client_name: "Lifting".to_owned(),
            requested_by_owner_browser: false,
        }
    }

    fn device(user_code: &str) -> NewestPendingConsent {
        NewestPendingConsent::Device {
            user_code: user_code.to_owned(),
            client_name: "Pebble".to_owned(),
        }
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
        let mut coalescer = notifying();
        let first = coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(None)),
        ]));
        assert_eq!(summary(&first.posted), [(RUTH, oauth_key("a"))]);

        let again = coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(None)),
        ]));
        assert!(again.posted.is_empty());
    }

    #[test]
    fn a_newer_request_notifies_while_the_earlier_one_waits() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));

        let newer = coalescer.record(&statuses([(RUTH, running_with(Some(device("CODE"))))]));
        assert_eq!(summary(&newer.posted), [(RUTH, device_key("CODE"))]);
    }

    #[test]
    fn a_request_that_comes_back_once_a_newer_one_is_decided_does_not_notify_again() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("b"))))]));

        let back = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        assert!(back.posted.is_empty());
    }

    #[test]
    fn a_request_never_newest_before_notifies_when_it_comes_back() {
        let mut coalescer = notifying();
        // "a" was requested first, but "b" came before the server reported.
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("b"))))]));

        let back = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        assert_eq!(summary(&back.posted), [(RUTH, oauth_key("a"))]);
    }

    #[test]
    fn a_request_seen_before_a_restart_does_not_notify_again() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        assert!(coalescer
            .record(&statuses([(RUTH, UnitStatus::never_run())]))
            .posted
            .is_empty());

        let restarted = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        assert!(restarted.posted.is_empty());
    }

    #[test]
    fn nothing_pending_forgets_the_requests_notified_for() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        coalescer.record(&statuses([(RUTH, running_with(None))]));

        // A decided or expired request never comes back; this one stands in
        // to show the server forgot it.
        let again = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        assert_eq!(summary(&again.posted), [(RUTH, oauth_key("a"))]);
    }

    #[test]
    fn a_server_forgets_its_earliest_request_past_its_limit() {
        let mut coalescer = notifying();
        for index in 0..=NOTIFIED_PER_SERVER {
            coalescer.record(&statuses([(
                RUTH,
                running_with(Some(oauth(&index.to_string()))),
            )]));
        }

        let kept = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("1"))))]));
        assert!(kept.posted.is_empty());
        let forgotten = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("0"))))]));
        assert_eq!(summary(&forgotten.posted), [(RUTH, oauth_key("0"))]);
    }

    #[test]
    fn a_removed_server_is_forgotten() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        coalescer.record(&statuses([]));

        let added_again = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        assert_eq!(summary(&added_again.posted), [(RUTH, oauth_key("a"))]);
    }

    #[test]
    fn a_request_that_comes_back_withdraws_the_newer_one_s_notification() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("b"))))]));

        let back = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        assert_eq!(back.withdrawn, [RUTH]);
        let still = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        assert_eq!(still, ConsentNotificationChanges::default());
    }

    #[test]
    fn nothing_pending_withdraws_the_notification_once() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));

        let settled = coalescer.record(&statuses([(RUTH, running_with(None))]));
        assert_eq!(settled.withdrawn, [RUTH]);
        let still = coalescer.record(&statuses([(RUTH, running_with(None))]));
        assert!(still.withdrawn.is_empty());
    }

    #[test]
    fn a_run_not_reporting_keeps_the_notification() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));

        let restarting = coalescer.record(&statuses([(RUTH, UnitStatus::never_run())]));
        assert!(restarting.withdrawn.is_empty());
    }

    #[test]
    fn a_removed_server_s_notification_is_withdrawn() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));

        let removed = coalescer.record(&statuses([]));
        assert_eq!(removed.withdrawn, [RUTH]);
    }

    fn oauth_from_owner_browser(id: &str) -> NewestPendingConsent {
        NewestPendingConsent::OAuth {
            id: id.to_owned(),
            client_name: "Lifting".to_owned(),
            requested_by_owner_browser: true,
        }
    }

    #[test]
    fn a_request_the_owner_s_browser_made_does_not_notify() {
        let mut coalescer = notifying();
        let changes = coalescer.record(&statuses([(
            RUTH,
            running_with(Some(oauth_from_owner_browser("a"))),
        )]));
        assert_eq!(changes, ConsentNotificationChanges::default());
    }

    #[test]
    fn a_request_the_owner_s_browser_made_withdraws_an_older_notification() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));

        let newer = coalescer.record(&statuses([(
            RUTH,
            running_with(Some(oauth_from_owner_browser("b"))),
        )]));
        assert!(newer.posted.is_empty());
        assert_eq!(newer.withdrawn, [RUTH]);
    }

    #[test]
    fn a_request_the_owner_s_browser_made_does_not_notify_when_it_comes_back() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(
            RUTH,
            running_with(Some(oauth_from_owner_browser("a"))),
        )]));
        let newer = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("b"))))]));
        assert_eq!(summary(&newer.posted), [(RUTH, oauth_key("b"))]);

        let back = coalescer.record(&statuses([(
            RUTH,
            running_with(Some(oauth_from_owner_browser("a"))),
        )]));
        assert!(back.posted.is_empty());
        assert_eq!(back.withdrawn, [RUTH], "b's notification goes");
    }

    #[test]
    fn on_a_phone_the_request_a_server_reports_at_start_opens_instead_of_notifying() {
        let mut coalescer = ConsentNotificationCoalescer::new(ConsentOpening::FirstAtStart);
        let start = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        assert_eq!(summary(&start.opened), [(RUTH, oauth_key("a"))]);
        assert!(start.posted.is_empty());

        let later = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("b"))))]));
        assert_eq!(summary(&later.posted), [(RUTH, oauth_key("b"))]);
        assert!(later.opened.is_empty(), "a later request notifies");

        let back = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        assert!(back.posted.is_empty() && back.opened.is_empty());
    }

    #[test]
    fn on_a_phone_only_the_first_server_s_request_opens_at_start() {
        let mut coalescer = ConsentNotificationCoalescer::new(ConsentOpening::FirstAtStart);
        let start = coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(Some(oauth("b")))),
        ]));
        assert_eq!(summary(&start.opened), [(LAB, oauth_key("b"))]);
        assert_eq!(summary(&start.posted), [(RUTH, oauth_key("a"))]);
    }

    #[test]
    fn on_a_phone_a_request_after_a_start_with_none_notifies() {
        let mut coalescer = ConsentNotificationCoalescer::new(ConsentOpening::FirstAtStart);
        coalescer.record(&statuses([(RUTH, running_with(None))]));

        let later = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        assert_eq!(summary(&later.posted), [(RUTH, oauth_key("a"))]);
        assert!(later.opened.is_empty());
    }

    #[test]
    fn on_a_phone_a_run_not_reporting_at_start_opens_its_first_report_s_request() {
        let mut coalescer = ConsentNotificationCoalescer::new(ConsentOpening::FirstAtStart);
        coalescer.record(&statuses([(RUTH, UnitStatus::never_run())]));

        let started = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        assert_eq!(summary(&started.opened), [(RUTH, oauth_key("a"))]);
    }

    #[test]
    fn on_a_phone_a_request_the_owner_s_browser_made_does_not_open_at_start() {
        let mut coalescer = ConsentNotificationCoalescer::new(ConsentOpening::FirstAtStart);
        let start = coalescer.record(&statuses([
            (LAB, running_with(Some(oauth_from_owner_browser("a")))),
            (RUTH, running_with(Some(oauth("b")))),
        ]));
        assert_eq!(summary(&start.opened), [(RUTH, oauth_key("b"))]);
        assert!(start.posted.is_empty());
    }

    #[test]
    fn on_the_desktop_each_request_that_notifies_opens() {
        let mut coalescer = ConsentNotificationCoalescer::new(ConsentOpening::AsNotified);
        let start = coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(Some(oauth_from_owner_browser("b")))),
        ]));
        assert_eq!(summary(&start.posted), [(RUTH, oauth_key("a"))]);
        assert_eq!(start.opened, start.posted);

        let later = coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("c")))),
            (LAB, running_with(Some(oauth_from_owner_browser("b")))),
        ]));
        assert_eq!(summary(&later.opened), [(RUTH, oauth_key("c"))]);
    }

    #[test]
    fn each_server_notifies_for_its_own_request() {
        let mut coalescer = notifying();
        let requests = coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(Some(oauth("a")))),
        ]));
        assert_eq!(
            summary(&requests.posted),
            [(LAB, oauth_key("a")), (RUTH, oauth_key("a"))]
        );
    }

    #[test]
    fn each_server_with_a_request_pending_counts_once() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(Some(device("WXYZ-1234")))),
        ]));
        assert_eq!(coalescer.pending_server_count(), 2);

        coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("b")))),
            (LAB, running_with(Some(device("WXYZ-1234")))),
        ]));
        assert_eq!(coalescer.pending_server_count(), 2, "a newer request");
    }

    #[test]
    fn a_server_counts_until_nothing_is_pending_or_it_is_removed() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(Some(oauth("b")))),
        ]));

        let settled = coalescer.record(&statuses([
            (RUTH, running_with(None)),
            (LAB, running_with(Some(oauth("b")))),
        ]));
        assert_eq!(settled.withdrawn, [RUTH]);
        assert_eq!(coalescer.pending_server_count(), 1);

        let removed = coalescer.record(&statuses([(RUTH, running_with(None))]));
        assert_eq!(removed.withdrawn, [LAB]);
        assert_eq!(coalescer.pending_server_count(), 0);
    }

    #[test]
    fn a_run_not_reporting_keeps_its_server_counted() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));

        let stopped = coalescer.record(&statuses([(RUTH, UnitStatus::never_run())]));
        assert!(stopped.withdrawn.is_empty());
        assert_eq!(coalescer.pending_server_count(), 1);
    }

    #[test]
    fn a_run_not_reporting_from_the_start_does_not_count() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(RUTH, UnitStatus::never_run())]));
        assert_eq!(coalescer.pending_server_count(), 0);
    }

    #[test]
    fn a_request_that_did_not_notify_counts() {
        let mut coalescer = ConsentNotificationCoalescer::new(ConsentOpening::FirstAtStart);
        let start = coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(Some(oauth_from_owner_browser("b")))),
        ]));
        assert!(start.posted.is_empty());
        assert_eq!(coalescer.pending_server_count(), 2);
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
