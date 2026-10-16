//! The notifications for the consents waiting on the servers:
//! [`ConsentRequest`], what one notification says;
//! [`ConsentNotificationCoalescer`], which picks the requests that notify, and
//! the servers whose notification is withdrawn, out of `UnitRunner`'s
//! statuses; and [`server_of_consent_notification`], the server a tapped
//! notification is for, by [`consent_notification_id_for_plugin`].

use std::collections::{BTreeMap, VecDeque};

use wildflowerhealthio_unit_runner::{AppReturn, UnitId, UnitStatuses};

use crate::domain::notifications::local_notification::LocalNotification;
use crate::domain::{ConsentKey, PendingConsent, ServerDetail, ServerRunId};

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
/// the app's start, which opens instead of notifying, and one request at each
/// return to the foreground ([`returned_to_foreground`](Self::returned_to_foreground)).
///
/// A server remembers the requests it notified for or opened until its run
/// reports nothing pending, since then each of them is decided or expired and
/// none can come back, keeping at most [`NOTIFIED_PER_SERVER`] meanwhile. A
/// run that isn't reporting, as while it stops or starts, leaves them, and
/// its notification, as they are. A server that is removed is forgotten.
#[derive(Debug)]
pub struct ConsentNotificationCoalescer {
    /// Which requests open.
    opening: ConsentOpening,
    /// The run each server last reported from, for each server whose run has
    /// reported since the app started.
    reporting_runs: BTreeMap<UnitId, ServerRunId>,
    /// Whether a request opened at the app's start already
    /// ([`ConsentOpening::FirstAtStart`]).
    opened_at_start: bool,
    /// The servers whose first report since the latest return to the
    /// foreground opens its request, each with the run it reported from as
    /// the app returned, whose reports don't count, if any; a server leaves
    /// once a later run reports, and all leave once one opens a request
    /// ([`ConsentOpening::FirstAtStart`]).
    awaiting_first_report_since_return: BTreeMap<UnitId, Option<ServerRunId>>,
    /// The requests each server notified for or opened, and those the
    /// Owner's own browser made, earliest first.
    notified: BTreeMap<UnitId, VecDeque<NotifiedRequest>>,
    /// How many requests every server has notified for, opened, or seen the
    /// Owner's own browser make, which orders them across servers.
    requests_seen: u64,
    /// The key of the request each server's notification announces, for each
    /// server with one posted and not withdrawn.
    announced: BTreeMap<UnitId, ConsentKey>,
}

/// A request a server notified for, opened, or saw the Owner's own browser
/// make.
#[derive(Debug)]
struct NotifiedRequest {
    /// The request.
    key: ConsentKey,
    /// How many requests every server had seen before it, so the latest seen
    /// has the highest.
    seen_after: u64,
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
    /// order, while a request on any other server notifies. A return to the
    /// foreground opens one request too, as
    /// [`ConsentNotificationCoalescer::returned_to_foreground`] says.
    FirstAtStart,
}

/// What a [`ConsentNotificationCoalescer`] decided from one set of statuses.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ConsentNotificationChanges {
    /// The requests that notify, in domain order.
    pub posted: Vec<ConsentRequest>,
    /// The requests that open, in domain order: each posted one under
    /// [`ConsentOpening::AsNotified`], or the one opened at the app's start
    /// or at a return to the foreground under [`ConsentOpening::FirstAtStart`].
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
            reporting_runs: BTreeMap::new(),
            opened_at_start: false,
            awaiting_first_report_since_return: BTreeMap::new(),
            notified: BTreeMap::new(),
            requests_seen: 0,
            announced: BTreeMap::new(),
        }
    }

    /// The requests in `statuses` that notify or open, and the servers whose
    /// notification is withdrawn.
    pub fn record(&mut self, statuses: &UnitStatuses<ServerDetail>) -> ConsentNotificationChanges {
        let mut changes = ConsentNotificationChanges::default();
        self.notified
            .retain(|unit_id, _| statuses.contains_key(unit_id));
        self.awaiting_first_report_since_return
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
            let first_report_since_start = self
                .reporting_runs
                .insert(unit_id.clone(), detail.run)
                .is_none();
            let first_report_since_return = self
                .awaiting_first_report_since_return
                .get(unit_id)
                .is_some_and(|run_at_return| *run_at_return != Some(detail.run));
            if first_report_since_return {
                self.awaiting_first_report_since_return.remove(unit_id);
            }
            let Some(newest) = detail.pending_consent.clone() else {
                self.notified.remove(unit_id);
                if self.announced.remove(unit_id).is_some() {
                    changes.withdrawn.push(unit_id.as_str().to_owned());
                }
                continue;
            };
            let pending_consent = PendingConsent::from(newest);
            let notified = self.notified.entry(unit_id.clone()).or_default();
            let notified_before = notified
                .iter()
                .any(|notified_request| notified_request.key == pending_consent.key);
            if notified_before {
                if self
                    .announced
                    .get(unit_id)
                    .is_some_and(|announced| *announced != pending_consent.key)
                {
                    self.announced.remove(unit_id);
                    changes.withdrawn.push(unit_id.as_str().to_owned());
                }
            } else {
                if notified.len() == NOTIFIED_PER_SERVER {
                    notified.pop_front();
                }
                notified.push_back(NotifiedRequest {
                    key: pending_consent.key.clone(),
                    seen_after: self.requests_seen,
                });
                self.requests_seen += 1;
                if pending_consent.requested_by_owner_browser
                    && self.announced.remove(unit_id).is_some()
                {
                    changes.withdrawn.push(unit_id.as_str().to_owned());
                }
            }
            if pending_consent.requested_by_owner_browser {
                continue;
            }
            let request = ConsentRequest {
                domain: unit_id.as_str().to_owned(),
                pending_consent,
            };
            if self.opening == ConsentOpening::FirstAtStart {
                if first_report_since_start && !self.opened_at_start {
                    self.opened_at_start = true;
                    changes.opened.push(request);
                    continue;
                }
                // Even a request it notified for before its run stopped.
                if first_report_since_return {
                    self.awaiting_first_report_since_return.clear();
                    changes.opened.push(request);
                    continue;
                }
            }
            if notified_before {
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

    /// The request that opens as the app returns to the foreground
    /// (`app_return`), under [`ConsentOpening::FirstAtStart`]: at most one
    /// per return. On the desktop ([`ConsentOpening::AsNotified`]) a return
    /// opens nothing.
    ///
    /// Of the servers whose run carried on across the return, each whose
    /// newest request is one it notified for or opened, and so still pending,
    /// is a candidate, and the request seen latest opens now: the Owner saw
    /// it and came back to decide it, or closed its view undecided and came
    /// back to it. Failing one, each server the return resumed, or whose run
    /// carried on without reporting yet, has its next run's first report open
    /// its request, even one it notified for before its run stopped: the
    /// first of those servers to report a request opens it, and none after.
    /// A server whose policy doesn't run it at the return, as one the Owner
    /// turns on later, notifies as usual. A request the Owner's own browser
    /// made opens neither way, as it never notifies.
    pub fn returned_to_foreground(
        &mut self,
        app_return: &AppReturn<ServerDetail>,
    ) -> ConsentNotificationChanges {
        let mut changes = ConsentNotificationChanges::default();
        self.awaiting_first_report_since_return.clear();
        if self.opening != ConsentOpening::FirstAtStart {
            return changes;
        }
        let reopened = app_return
            .carried_on
            .iter()
            .filter_map(|(unit_id, unit_status)| {
                let pending_consent = PendingConsent::of_run(unit_status)
                    .filter(|newest| !newest.requested_by_owner_browser)?;
                let seen_after = self
                    .notified
                    .get(unit_id)?
                    .iter()
                    .find(|notified_request| notified_request.key == pending_consent.key)?
                    .seen_after;
                let request = ConsentRequest {
                    domain: unit_id.as_str().to_owned(),
                    pending_consent,
                };
                Some((seen_after, request))
            })
            .max_by_key(|(seen_after, _)| *seen_after);
        if let Some((_, request)) = reopened {
            changes.opened.push(request);
            return changes;
        }
        let not_reporting = app_return
            .carried_on
            .iter()
            .filter(|(_, unit_status)| unit_status.detail.is_none());
        self.awaiting_first_report_since_return = app_return
            .resumed
            .iter()
            .chain(not_reporting)
            .map(|(unit_id, unit_status)| {
                let run_at_return = unit_status.detail.as_ref().map(|detail| detail.run);
                (unit_id.clone(), run_at_return)
            })
            .collect();
        changes
    }
}

#[cfg(test)]
mod tests {
    use std::sync::OnceLock;

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

    /// A status reporting from the run every [`running_with`] status
    /// reports from, `pending_consent` the newest request waiting.
    fn running_with(pending_consent: Option<NewestPendingConsent>) -> UnitStatus<ServerDetail> {
        static THE_RUN: OnceLock<ServerRunId> = OnceLock::new();
        reporting(*THE_RUN.get_or_init(ServerRunId::next), pending_consent)
    }

    /// A status reporting from `run`, `pending_consent` the newest request
    /// waiting.
    fn reporting(
        run: ServerRunId,
        pending_consent: Option<NewestPendingConsent>,
    ) -> UnitStatus<ServerDetail> {
        UnitStatus {
            run_state: RunState::Running,
            running_since: None,
            detail: Some(ServerDetail {
                run,
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

    /// A return to the foreground across which the runs in `carried_on`
    /// carried on, and that resumed the servers in `resumed`.
    fn app_return(
        carried_on: UnitStatuses<ServerDetail>,
        resumed: UnitStatuses<ServerDetail>,
    ) -> AppReturn<ServerDetail> {
        AppReturn {
            carried_on,
            resumed,
        }
    }

    #[test]
    fn on_a_phone_a_return_with_the_run_carried_on_opens_the_announced_request() {
        let mut coalescer = notifying();
        let running = statuses([(RUTH, running_with(Some(oauth("a"))))]);
        coalescer.record(&running);

        let returned = coalescer.returned_to_foreground(&app_return(running.clone(), statuses([])));
        assert_eq!(summary(&returned.opened), [(RUTH, oauth_key("a"))]);
        assert!(returned.posted.is_empty() && returned.withdrawn.is_empty());
        let still = coalescer.record(&running);
        assert_eq!(
            still,
            ConsentNotificationChanges::default(),
            "it opens once"
        );
    }

    #[test]
    fn on_a_phone_each_return_opens_the_announced_request_again() {
        let mut coalescer = notifying();
        let running = statuses([(RUTH, running_with(Some(oauth("a"))))]);
        coalescer.record(&running);
        coalescer.returned_to_foreground(&app_return(running.clone(), statuses([])));

        // The Owner closed its view without deciding, and left again.
        let again = coalescer.returned_to_foreground(&app_return(running, statuses([])));
        assert_eq!(summary(&again.opened), [(RUTH, oauth_key("a"))]);
    }

    #[test]
    fn on_a_phone_a_request_opened_at_start_and_closed_undecided_opens_again_at_a_return() {
        let mut coalescer = ConsentNotificationCoalescer::new(ConsentOpening::FirstAtStart);
        let running = statuses([(RUTH, running_with(Some(oauth("a"))))]);
        let start = coalescer.record(&running);
        assert_eq!(summary(&start.opened), [(RUTH, oauth_key("a"))]);

        let returned = coalescer.returned_to_foreground(&app_return(running, statuses([])));
        assert_eq!(summary(&returned.opened), [(RUTH, oauth_key("a"))]);
    }

    #[test]
    fn on_a_phone_a_return_opens_one_request_the_one_seen_latest() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(LAB, running_with(Some(oauth("b"))))]));
        let running = statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(Some(oauth("b")))),
        ]);
        coalescer.record(&running);

        let returned = coalescer.returned_to_foreground(&app_return(running, statuses([])));
        assert_eq!(summary(&returned.opened), [(RUTH, oauth_key("a"))]);
    }

    #[test]
    fn on_a_phone_a_return_with_nothing_surfaced_opens_nothing() {
        let mut coalescer = notifying();
        let running = statuses([
            (RUTH, running_with(None)),
            (LAB, running_with(Some(oauth_from_owner_browser("a")))),
        ]);
        coalescer.record(&running);

        let returned = coalescer.returned_to_foreground(&app_return(running.clone(), statuses([])));
        assert_eq!(returned, ConsentNotificationChanges::default());
        assert_eq!(
            coalescer.record(&running),
            ConsentNotificationChanges::default()
        );
    }

    #[test]
    fn on_a_phone_a_return_opens_no_request_the_run_no_longer_has_newest() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));

        // "b" arrived as the app returned, before the coalescer saw it.
        let returned = coalescer.returned_to_foreground(&app_return(
            statuses([(RUTH, running_with(Some(oauth("b"))))]),
            statuses([]),
        ));
        assert!(returned.opened.is_empty());
    }

    #[test]
    fn on_a_phone_a_notified_request_opens_on_the_first_report_of_a_run_a_return_resumed() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        let stopped = statuses([(RUTH, UnitStatus::never_run())]);
        coalescer.record(&stopped);

        let returned = coalescer.returned_to_foreground(&app_return(statuses([]), stopped.clone()));
        assert_eq!(returned, ConsentNotificationChanges::default());
        let starting = coalescer.record(&stopped);
        assert!(starting.opened.is_empty(), "not reporting yet");

        let restarted = coalescer.record(&statuses([(
            RUTH,
            reporting(ServerRunId::next(), Some(oauth("a"))),
        )]));
        assert_eq!(summary(&restarted.opened), [(RUTH, oauth_key("a"))]);
        assert!(restarted.posted.is_empty() && restarted.withdrawn.is_empty());
        let later = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("b"))))]));
        assert_eq!(summary(&later.posted), [(RUTH, oauth_key("b"))]);
        assert!(later.opened.is_empty(), "one open per return");
    }

    #[test]
    fn on_a_phone_a_run_restarted_for_a_return_opens_on_its_new_run_s_first_report_only() {
        let mut coalescer = notifying();
        let old_run = statuses([(RUTH, running_with(Some(oauth("a"))))]);
        coalescer.record(&old_run);

        // As on iOS: the old run was asked to stop, and still reports until
        // it has.
        coalescer.returned_to_foreground(&app_return(statuses([]), old_run.clone()));
        let stopping = coalescer.record(&old_run);
        assert_eq!(
            stopping,
            ConsentNotificationChanges::default(),
            "the old run's report isn't the new run's"
        );
        coalescer.record(&statuses([(RUTH, UnitStatus::never_run())]));

        let new_run = coalescer.record(&statuses([(
            RUTH,
            reporting(ServerRunId::next(), Some(oauth("a"))),
        )]));
        assert_eq!(summary(&new_run.opened), [(RUTH, oauth_key("a"))]);
    }

    #[test]
    fn on_a_phone_a_return_that_opens_at_once_opens_nothing_on_a_resumed_run() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(Some(oauth("b")))),
        ]));

        // LAB's run stopped while the app was away; RUTH's carried on.
        let returned = coalescer.returned_to_foreground(&app_return(
            statuses([(RUTH, running_with(Some(oauth("a"))))]),
            statuses([(LAB, UnitStatus::never_run())]),
        ));
        assert_eq!(summary(&returned.opened), [(RUTH, oauth_key("a"))]);
        let restarted = coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, reporting(ServerRunId::next(), Some(oauth("b")))),
        ]));
        assert_eq!(restarted, ConsentNotificationChanges::default());
    }

    #[test]
    fn on_a_phone_a_server_a_return_didn_t_resume_notifies_once_it_runs() {
        let mut coalescer = notifying();
        let running = statuses([(RUTH, running_with(None)), (LAB, UnitStatus::never_run())]);
        coalescer.record(&running);

        // LAB is off at the return; the Owner turns it on later.
        coalescer.returned_to_foreground(&app_return(
            statuses([(RUTH, running_with(None))]),
            statuses([]),
        ));
        let turned_on = coalescer.record(&statuses([
            (RUTH, running_with(None)),
            (LAB, running_with(Some(oauth("b")))),
        ]));
        assert_eq!(summary(&turned_on.posted), [(LAB, oauth_key("b"))]);
        assert!(turned_on.opened.is_empty());
    }

    #[test]
    fn on_a_phone_a_resumed_run_reporting_nothing_first_leaves_its_later_request_notifying() {
        let mut coalescer = notifying();
        let stopped = statuses([(RUTH, UnitStatus::never_run())]);
        coalescer.record(&stopped);
        coalescer.returned_to_foreground(&app_return(statuses([]), stopped));

        let run = ServerRunId::next();
        coalescer.record(&statuses([(RUTH, reporting(run, None))]));
        let later = coalescer.record(&statuses([(RUTH, reporting(run, Some(oauth("a"))))]));
        assert_eq!(summary(&later.posted), [(RUTH, oauth_key("a"))]);
        assert!(later.opened.is_empty());
    }

    #[test]
    fn on_a_phone_a_return_never_rearms_the_open_at_start() {
        let mut coalescer = ConsentNotificationCoalescer::new(ConsentOpening::FirstAtStart);
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        coalescer.record(&statuses([(RUTH, running_with(None))]));

        coalescer.returned_to_foreground(&app_return(
            statuses([(RUTH, running_with(None))]),
            statuses([]),
        ));
        let added = coalescer.record(&statuses([
            (RUTH, running_with(None)),
            (LAB, running_with(Some(oauth("b")))),
        ]));
        assert_eq!(summary(&added.posted), [(LAB, oauth_key("b"))]);
        assert!(added.opened.is_empty());
    }

    #[test]
    fn on_a_phone_a_request_the_owner_s_browser_made_does_not_open_after_a_return() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        coalescer.returned_to_foreground(&app_return(
            statuses([]),
            statuses([(RUTH, UnitStatus::never_run())]),
        ));

        let restarted = coalescer.record(&statuses([(
            RUTH,
            reporting(ServerRunId::next(), Some(oauth_from_owner_browser("b"))),
        )]));
        assert!(restarted.opened.is_empty() && restarted.posted.is_empty());
        assert_eq!(restarted.withdrawn, [RUTH], "a's notification goes");
    }

    #[test]
    fn on_the_desktop_a_return_opens_nothing() {
        let mut coalescer = ConsentNotificationCoalescer::new(ConsentOpening::AsNotified);
        let running = statuses([(RUTH, running_with(Some(oauth("a"))))]);
        coalescer.record(&running);

        assert_eq!(
            coalescer.returned_to_foreground(&app_return(running, statuses([]))),
            ConsentNotificationChanges::default()
        );
        coalescer.returned_to_foreground(&app_return(
            statuses([]),
            statuses([(RUTH, UnitStatus::never_run())]),
        ));
        assert_eq!(
            coalescer.record(&statuses([(
                RUTH,
                reporting(ServerRunId::next(), Some(oauth("a")))
            )])),
            ConsentNotificationChanges::default()
        );
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
