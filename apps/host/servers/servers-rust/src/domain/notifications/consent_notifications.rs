//! The notifications for the consents waiting on the servers:
//! [`ConsentRequest`], what one notification says;
//! [`ConsentNotificationCoalescer`], which picks the requests that notify, and
//! the servers whose notification is withdrawn, out of `UnitRunner`'s
//! statuses, with the ongoing notification and the requests the
//! notifications posted name ([`AnnouncedConsents`]); and
//! [`server_of_consent_notification`], the server a tapped notification is
//! for, by [`consent_notification_id_for_plugin`].

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use wildflowerhealthio_unit_runner::{RunState, UnitId, UnitStatuses};

use crate::domain::notifications::announced_consents::{
    AnnouncedConsents, OngoingConsentNotification,
};
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
/// A request that can be decided in the browser that made it
/// (`decidable_in_requesting_browser`) never notifies: that browser already
/// shows its consent card. It still counts as the server's newest, so it
/// withdraws the server's notification for an older one, and counts as
/// notified for, so it doesn't notify when it comes back either.
///
/// A server's notification stays while the request it announced is the
/// server's newest; once another that notified before is newest, or nothing
/// is pending, the server's notification is withdrawn, so it never announces
/// a request decided or expired. A server that is removed has it withdrawn
/// too.
///
/// Which requests open, as [`ConsentOpening`] says: on the desktop each
/// one that notifies; on a phone one at each arrival of the app in the
/// foreground ([`came_to_foreground`](Self::came_to_foreground)).
///
/// A server remembers the requests it notified for or opened until its run
/// reports nothing pending, since then each of them is decided or expired and
/// none can come back, keeping at most [`NOTIFIED_PER_SERVER`] meanwhile, and
/// remembers its newest request as its run last reported it. A run that isn't
/// reporting, as while it stops or starts, leaves them, and its notification,
/// as they are. A server that is removed is forgotten.
///
/// The servers it remembers requests for are the ones with a request
/// pending, as their run last reported:
/// [`pending_server_count`](Self::pending_server_count), what the app icon's
/// badge shows, and, of those, the ones the
/// [ongoing notification](Self::ongoing_notification) counts; it names a
/// request only while no notification of its server's own shows it. Which
/// request each notification posted names, for an action on it to act on, is
/// [`announced_consents`](Self::announced_consents), less those a tap took
/// down ([`notification_taken_down`](Self::notification_taken_down)).
#[derive(Debug)]
pub struct ConsentNotificationCoalescer {
    /// Which requests open.
    opening: ConsentOpening,
    /// The newest request each server's run last reported, kept while its
    /// run isn't reporting, as while it stops or starts, so an arrival in the
    /// foreground can open it; none for a server whose run last reported
    /// nothing pending.
    newest: BTreeMap<UnitId, PendingConsent>,
    /// The servers on their way up at the latest arrival in the foreground
    /// that opened no request at once, whose first report's request opens
    /// instead of notifying ([`ConsentOpening::OnArrival`]), each with
    /// whether a run of it has been starting since. A server leaves on its
    /// first report, or once a run that started since stops before it
    /// reports, while a run that was stopping at the arrival, as one the iOS
    /// restart stops, stops without ending its wait; all leave once one opens
    /// a request, or the arrival's wait ends
    /// ([`end_arrival_wait`](ConsentNotificationCoalescer::end_arrival_wait)).
    awaiting_first_report: BTreeMap<UnitId, bool>,
    /// The requests each server notified for or opened, and those the
    /// Owner's own browser made, earliest first, for each server with a
    /// request pending as its run last reported.
    notified: BTreeMap<UnitId, VecDeque<NotifiedRequest>>,
    /// How many requests every server has notified for, opened, or seen the
    /// Owner's own browser make, which orders them across servers.
    requests_seen: u64,
    /// The request each server's notification announces, for each server
    /// with one posted and neither withdrawn nor taken down.
    announced: BTreeMap<UnitId, PendingConsent>,
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
    /// click a notification. Arrivals in the foreground open nothing.
    AsNotified,
    /// A tap on a notification opens its request, as on a phone, and each
    /// arrival of the app in the foreground opens one, as
    /// [`ConsentNotificationCoalescer::came_to_foreground`] says.
    OnArrival,
}

/// What a [`ConsentNotificationCoalescer`] decided from one set of statuses.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ConsentNotificationChanges {
    /// The requests that notify, in domain order.
    pub posted: Vec<ConsentRequest>,
    /// The requests that open, in domain order: each posted one under
    /// [`ConsentOpening::AsNotified`], or the one an arrival in the
    /// foreground opens under [`ConsentOpening::OnArrival`].
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
            newest: BTreeMap::new(),
            awaiting_first_report: BTreeMap::new(),
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
        self.newest
            .retain(|unit_id, _| statuses.contains_key(unit_id));
        self.awaiting_first_report
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
                self.follow_awaited_run(unit_id, &unit_status.run_state);
                continue;
            };
            let first_report_awaited = self.awaiting_first_report.remove(unit_id).is_some();
            let Some(newest) = detail.pending_consent.clone() else {
                self.notified.remove(unit_id);
                self.newest.remove(unit_id);
                if self.announced.remove(unit_id).is_some() {
                    changes.withdrawn.push(unit_id.as_str().to_owned());
                }
                continue;
            };
            let pending_consent = PendingConsent::from(newest);
            self.newest.insert(unit_id.clone(), pending_consent.clone());
            let notified = self.notified.entry(unit_id.clone()).or_default();
            let notified_before = notified
                .iter()
                .any(|notified_request| notified_request.key == pending_consent.key);
            if notified_before {
                if self
                    .announced
                    .get(unit_id)
                    .is_some_and(|announced| announced.key != pending_consent.key)
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
                if pending_consent.decidable_in_requesting_browser
                    && self.announced.remove(unit_id).is_some()
                {
                    changes.withdrawn.push(unit_id.as_str().to_owned());
                }
            }
            if pending_consent.decidable_in_requesting_browser {
                continue;
            }
            let request = ConsentRequest {
                domain: unit_id.as_str().to_owned(),
                pending_consent,
            };
            // Even a request it notified for before.
            if first_report_awaited {
                self.awaiting_first_report.clear();
                changes.opened.push(request);
                continue;
            }
            if notified_before {
                continue;
            }
            self.announced
                .insert(unit_id.clone(), request.pending_consent.clone());
            if self.opening == ConsentOpening::AsNotified {
                changes.opened.push(request.clone());
            }
            changes.posted.push(request);
        }
        changes.withdrawn.sort();
        changes
    }

    /// End the latest arrival's wait for a server's first report, so the
    /// first request a server on its way up reports notifies as usual instead
    /// of opening: as when the app leaves the foreground, where nothing can
    /// open, or a tap on a notification opens the consent it announced.
    pub fn end_arrival_wait(&mut self) {
        self.awaiting_first_report.clear();
    }

    /// Follow the run of the server `unit_id`, not reporting, now
    /// `run_state`, while its first report is awaited: a run starting is the
    /// one awaited, and once one that started stops, its server's first
    /// report is no longer awaited.
    fn follow_awaited_run(&mut self, unit_id: &UnitId, run_state: &RunState) {
        let Some(run_started_since) = self.awaiting_first_report.get_mut(unit_id) else {
            return;
        };
        match run_state {
            RunState::Starting => *run_started_since = true,
            RunState::Stopped { .. } if *run_started_since => {
                self.awaiting_first_report.remove(unit_id);
            }
            RunState::Stopped { .. } | RunState::Running => {}
        }
    }

    /// The app came to the foreground, its servers' statuses `statuses`, and
    /// `units_to_run` the servers the unit runner runs now, each up, starting
    /// or about to start: [`record`](Self::record)'s changes for `statuses`,
    /// and, under [`ConsentOpening::OnArrival`], at most one request that
    /// opens for the arrival. On the desktop ([`ConsentOpening::AsNotified`])
    /// an arrival opens nothing.
    ///
    /// Of the newest requests of the servers in `units_to_run` as their runs
    /// last reported them, each the server notified for or opened is a
    /// candidate, and the one seen latest opens: the Owner saw it and came
    /// back to decide it, or closed its view undecided and came back to it, or
    /// it notified while the app was in the background. A server whose run
    /// stopped while the app was away, or is stopping for the restart a
    /// return brings, still has its last report's request, which opens once a
    /// run reports it again, as the opener waits for. A request first seen in
    /// `statuses` opens instead of notifying.
    ///
    /// Failing a candidate, each server in `units_to_run` whose run isn't
    /// reporting, as one starting at the app's start, is on its way up: the
    /// first of those to report a request opens it instead of notifying, even
    /// one it notified for before, and none after, until the arrival's wait
    /// ends ([`end_arrival_wait`](Self::end_arrival_wait)). A server whose run the
    /// arrival started stops before it reports, or that isn't on its way up,
    /// as one whose policy is off or the Owner turns on later, notifies as
    /// usual. A request the Owner's own browser made opens neither way, as it
    /// never notifies.
    pub fn came_to_foreground(
        &mut self,
        statuses: &UnitStatuses<ServerDetail>,
        units_to_run: &BTreeSet<UnitId>,
    ) -> ConsentNotificationChanges {
        // Before recording, so no wait from an earlier arrival opens one too.
        self.awaiting_first_report.clear();
        let mut changes = self.record(statuses);
        if self.opening != ConsentOpening::OnArrival {
            return changes;
        }
        let surfaced = self
            .newest
            .iter()
            .filter(|(unit_id, newest)| {
                units_to_run.contains(*unit_id) && !newest.decidable_in_requesting_browser
            })
            .filter_map(|(unit_id, newest)| {
                let seen_after = self
                    .notified
                    .get(unit_id)?
                    .iter()
                    .find(|notified_request| notified_request.key == newest.key)?
                    .seen_after;
                Some((seen_after, unit_id))
            })
            .max_by_key(|(seen_after, _)| *seen_after);
        if let Some((_, unit_id)) = surfaced {
            let request = ConsentRequest {
                domain: unit_id.as_str().to_owned(),
                pending_consent: self.newest[unit_id].clone(),
            };
            if let Some(index) = changes.posted.iter().position(|posted| *posted == request) {
                changes.posted.remove(index);
                self.announced.remove(unit_id);
            }
            changes.opened.push(request);
            return changes;
        }
        self.awaiting_first_report = statuses
            .iter()
            .filter(|(unit_id, unit_status)| {
                unit_status.detail.is_none() && units_to_run.contains(*unit_id)
            })
            .map(|(unit_id, _)| (unit_id.clone(), false))
            .collect();
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
    /// Owner's own browser made, one opened at an arrival in the foreground,
    /// or one that came back once a newer one was decided.
    #[must_use]
    pub fn pending_server_count(&self) -> usize {
        self.notified.len()
    }

    /// The ongoing consent notification, as the servers' runs last reported
    /// to [`record`](Self::record): while any server's newest request is one
    /// that notifies and no notification of its server's own shows it, the
    /// one of those seen latest, and how many servers have a request that
    /// notifies waiting, shown or not. A request the Owner's own browser made
    /// doesn't count, as it never notifies; nor does an older one under it.
    ///
    /// A request shows in its server's own notification from when it
    /// notifies until that is withdrawn or
    /// [taken down](Self::notification_taken_down), so the ongoing
    /// notification doesn't repeat it meanwhile; it names one that came back
    /// once a newer one was decided, one an arrival in the foreground opened,
    /// and one whose notification a tap took down.
    ///
    /// It follows the servers [`pending_server_count`](Self::pending_server_count)
    /// counts: a run that isn't reporting keeps its server's request, and the
    /// notification goes once every server reports nothing pending or is
    /// removed, or each request left shows in its server's own.
    #[must_use]
    pub fn ongoing_notification(&self) -> Option<OngoingConsentNotification> {
        let waiting: Vec<(u64, &UnitId, &PendingConsent)> = self
            .newest
            .iter()
            .filter(|(_, newest)| !newest.decidable_in_requesting_browser)
            .filter_map(|(unit_id, newest)| {
                let seen_after = self
                    .notified
                    .get(unit_id)?
                    .iter()
                    .find(|notified_request| notified_request.key == newest.key)?
                    .seen_after;
                Some((seen_after, unit_id, newest))
            })
            .collect();
        let (_, unit_id, newest) = waiting
            .iter()
            .filter(|(_, unit_id, newest)| {
                self.announced
                    .get(*unit_id)
                    .is_none_or(|announced| announced.key != newest.key)
            })
            .max_by_key(|(seen_after, _, _)| *seen_after)?;
        Some(OngoingConsentNotification {
            newest: ConsentRequest {
                domain: unit_id.as_str().to_owned(),
                pending_consent: (*newest).clone(),
            },
            waiting_server_count: waiting.len(),
        })
    }

    /// The notification the plugin posted under `plugin_id` was taken down,
    /// as a tap on its text or an action takes it down: a server's own
    /// notification no longer shows its request, which the
    /// [ongoing notification](Self::ongoing_notification) names from now on
    /// while it waits, and which no action on it can name any more. Any
    /// other notification, such as the ongoing one, changes nothing here.
    pub fn notification_taken_down(&mut self, plugin_id: i32) {
        self.announced
            .retain(|unit_id, _| consent_notification_id_for_plugin(unit_id.as_str()) != plugin_id);
    }

    /// The requests the consent notifications posted name: each server's
    /// own notification's while it is posted, and the
    /// [ongoing notification](Self::ongoing_notification)'s.
    #[must_use]
    pub fn announced_consents(&self) -> AnnouncedConsents {
        AnnouncedConsents {
            by_server: self
                .announced
                .iter()
                .map(|(unit_id, pending_consent)| ConsentRequest {
                    domain: unit_id.as_str().to_owned(),
                    pending_consent: pending_consent.clone(),
                })
                .collect(),
            ongoing: self
                .ongoing_notification()
                .map(|ongoing_notification| ongoing_notification.newest),
        }
    }
}

#[cfg(test)]
mod tests {
    use wildflowerhealthio_authorization_server::NewestPendingConsent;
    use wildflowerhealthio_unit_runner::{RunStop, StopReason, UnitStatus};

    use super::*;
    use crate::domain::notifications::announced_consents::ongoing_consent_notification_id_for_plugin;
    use crate::domain::server_status::tests::{statuses, LAB, RUTH};

    /// A phone's coalescer, which only notifies until the app comes to the
    /// foreground.
    fn notifying() -> ConsentNotificationCoalescer {
        ConsentNotificationCoalescer::new(ConsentOpening::OnArrival)
    }

    /// A status reporting `pending_consent` as the newest request waiting.
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
                consent_denier: None,
            }),
        }
    }

    fn oauth(id: &str) -> NewestPendingConsent {
        NewestPendingConsent::OAuth {
            id: id.to_owned(),
            client_name: "Lifting".to_owned(),
            decidable_in_requesting_browser: false,
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

    fn oauth_decidable_in_requesting_browser(id: &str) -> NewestPendingConsent {
        NewestPendingConsent::OAuth {
            id: id.to_owned(),
            client_name: "Lifting".to_owned(),
            decidable_in_requesting_browser: true,
        }
    }

    #[test]
    fn a_request_decidable_in_its_browser_does_not_notify() {
        let mut coalescer = notifying();
        let changes = coalescer.record(&statuses([(
            RUTH,
            running_with(Some(oauth_decidable_in_requesting_browser("a"))),
        )]));
        assert_eq!(changes, ConsentNotificationChanges::default());
    }

    #[test]
    fn a_request_decidable_in_its_browser_withdraws_an_older_notification() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));

        let newer = coalescer.record(&statuses([(
            RUTH,
            running_with(Some(oauth_decidable_in_requesting_browser("b"))),
        )]));
        assert!(newer.posted.is_empty());
        assert_eq!(newer.withdrawn, [RUTH]);
    }

    #[test]
    fn a_request_decidable_in_its_browser_does_not_notify_when_it_comes_back() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(
            RUTH,
            running_with(Some(oauth_decidable_in_requesting_browser("a"))),
        )]));
        let newer = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("b"))))]));
        assert_eq!(summary(&newer.posted), [(RUTH, oauth_key("b"))]);

        let back = coalescer.record(&statuses([(
            RUTH,
            running_with(Some(oauth_decidable_in_requesting_browser("a"))),
        )]));
        assert!(back.posted.is_empty());
        assert_eq!(back.withdrawn, [RUTH], "b's notification goes");
    }

    #[test]
    fn on_the_desktop_each_request_that_notifies_opens() {
        let mut coalescer = ConsentNotificationCoalescer::new(ConsentOpening::AsNotified);
        let start = coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (
                LAB,
                running_with(Some(oauth_decidable_in_requesting_browser("b"))),
            ),
        ]));
        assert_eq!(summary(&start.posted), [(RUTH, oauth_key("a"))]);
        assert_eq!(start.opened, start.posted);

        let later = coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("c")))),
            (
                LAB,
                running_with(Some(oauth_decidable_in_requesting_browser("b"))),
            ),
        ]));
        assert_eq!(summary(&later.opened), [(RUTH, oauth_key("c"))]);
    }

    /// The app comes to the foreground with the servers' statuses
    /// `statuses`, the unit runner running each server in `units_to_run`.
    fn come_to_foreground(
        coalescer: &mut ConsentNotificationCoalescer,
        statuses: &UnitStatuses<ServerDetail>,
        units_to_run: &[&str],
    ) -> ConsentNotificationChanges {
        let units_to_run = units_to_run.iter().copied().map(UnitId::from).collect();
        coalescer.came_to_foreground(statuses, &units_to_run)
    }

    /// A status whose run isn't reporting, as `run_state`.
    fn not_reporting(run_state: RunState) -> UnitStatus<ServerDetail> {
        UnitStatus {
            run_state,
            running_since: None,
            detail: None,
        }
    }

    /// A status whose run stopped for `reason`.
    fn stopped_for(reason: StopReason) -> UnitStatus<ServerDetail> {
        not_reporting(RunState::Stopped {
            last_stop: Some(RunStop {
                reason,
                error: None,
                stopped_at: chrono::DateTime::UNIX_EPOCH,
            }),
        })
    }

    #[test]
    fn on_a_phone_at_a_cold_start_the_first_starting_server_s_request_opens() {
        let mut coalescer = notifying();
        let arrived = come_to_foreground(
            &mut coalescer,
            &statuses([
                (RUTH, UnitStatus::never_run()),
                (LAB, UnitStatus::never_run()),
            ]),
            &[RUTH, LAB],
        );
        assert_eq!(arrived, ConsentNotificationChanges::default());
        coalescer.record(&statuses([
            (RUTH, not_reporting(RunState::Starting)),
            (LAB, not_reporting(RunState::Starting)),
        ]));

        let reported = coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(Some(oauth("b")))),
        ]));
        assert_eq!(summary(&reported.opened), [(LAB, oauth_key("b"))]);
        assert_eq!(
            summary(&reported.posted),
            [(RUTH, oauth_key("a"))],
            "one opens per arrival, the first in domain order"
        );
        let later = coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("c")))),
            (LAB, running_with(Some(oauth("b")))),
        ]));
        assert_eq!(summary(&later.posted), [(RUTH, oauth_key("c"))]);
        assert!(later.opened.is_empty());
    }

    #[test]
    fn on_a_phone_a_request_first_seen_at_an_arrival_opens_instead_of_notifying() {
        let mut coalescer = notifying();
        let arrived = come_to_foreground(
            &mut coalescer,
            &statuses([(RUTH, running_with(Some(oauth("a"))))]),
            &[RUTH],
        );
        assert_eq!(summary(&arrived.opened), [(RUTH, oauth_key("a"))]);
        assert!(arrived.posted.is_empty() && arrived.withdrawn.is_empty());
        let decided = coalescer.record(&statuses([(RUTH, running_with(None))]));
        assert!(decided.withdrawn.is_empty(), "nothing was announced");
    }

    #[test]
    fn on_a_phone_a_server_not_on_its_way_up_at_an_arrival_notifies() {
        let mut coalescer = notifying();
        // RUTH is off at the arrival; the Owner turns it on later.
        come_to_foreground(
            &mut coalescer,
            &statuses([(RUTH, UnitStatus::never_run())]),
            &[],
        );
        coalescer.record(&statuses([(RUTH, not_reporting(RunState::Starting))]));

        let turned_on = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        assert_eq!(summary(&turned_on.posted), [(RUTH, oauth_key("a"))]);
        assert!(turned_on.opened.is_empty());
    }

    #[test]
    fn on_a_phone_a_server_that_fails_to_start_and_starts_again_notifies() {
        let mut coalescer = notifying();
        come_to_foreground(
            &mut coalescer,
            &statuses([(RUTH, UnitStatus::never_run())]),
            &[RUTH],
        );
        coalescer.record(&statuses([(RUTH, not_reporting(RunState::Starting))]));
        coalescer.record(&statuses([(RUTH, stopped_for(StopReason::EndedOnItsOwn))]));
        coalescer.record(&statuses([(RUTH, not_reporting(RunState::Starting))]));

        let restarted = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        assert_eq!(summary(&restarted.posted), [(RUTH, oauth_key("a"))]);
        assert!(restarted.opened.is_empty());
    }

    #[test]
    fn on_a_phone_a_run_stopping_at_an_arrival_opens_its_next_run_s_first_request() {
        let mut coalescer = notifying();
        // As on iOS: the run is asked to stop for the restart the return
        // brings, and reports nothing while it does.
        come_to_foreground(
            &mut coalescer,
            &statuses([(RUTH, not_reporting(RunState::Running))]),
            &[RUTH],
        );
        coalescer.record(&statuses([(
            RUTH,
            stopped_for(StopReason::StoppedForRestart),
        )]));
        coalescer.record(&statuses([(RUTH, not_reporting(RunState::Starting))]));

        let restarted = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        assert_eq!(summary(&restarted.opened), [(RUTH, oauth_key("a"))]);
        assert!(restarted.posted.is_empty());
    }

    #[test]
    fn on_a_phone_a_first_report_with_nothing_to_open_ends_only_its_server_s_wait() {
        let mut coalescer = notifying();
        come_to_foreground(
            &mut coalescer,
            &statuses([
                (RUTH, UnitStatus::never_run()),
                (LAB, UnitStatus::never_run()),
            ]),
            &[RUTH, LAB],
        );
        let first = coalescer.record(&statuses([
            (RUTH, not_reporting(RunState::Starting)),
            (
                LAB,
                running_with(Some(oauth_decidable_in_requesting_browser("b"))),
            ),
        ]));
        assert_eq!(first, ConsentNotificationChanges::default());
        coalescer.record(&statuses([
            (RUTH, running_with(None)),
            (LAB, running_with(None)),
        ]));

        let later = coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(Some(oauth("c")))),
        ]));
        assert_eq!(
            summary(&later.posted),
            [(LAB, oauth_key("c")), (RUTH, oauth_key("a"))]
        );
        assert!(later.opened.is_empty());
    }

    #[test]
    fn on_a_phone_an_arrival_after_a_background_start_opens_the_request_notified_latest() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        let running = statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(Some(oauth("b")))),
        ]);
        coalescer.record(&running);

        let arrived = come_to_foreground(&mut coalescer, &running, &[RUTH, LAB]);
        assert_eq!(summary(&arrived.opened), [(LAB, oauth_key("b"))]);
        assert!(arrived.posted.is_empty() && arrived.withdrawn.is_empty());
        assert_eq!(
            coalescer.record(&running),
            ConsentNotificationChanges::default(),
            "it opens once"
        );
    }

    #[test]
    fn on_a_phone_each_arrival_opens_the_announced_request_again() {
        let mut coalescer = notifying();
        let running = statuses([(RUTH, running_with(Some(oauth("a"))))]);
        coalescer.record(&running);
        let first = come_to_foreground(&mut coalescer, &running, &[RUTH]);
        assert_eq!(summary(&first.opened), [(RUTH, oauth_key("a"))]);

        // The Owner closed its view without deciding, and left again.
        let again = come_to_foreground(&mut coalescer, &running, &[RUTH]);
        assert_eq!(summary(&again.opened), [(RUTH, oauth_key("a"))]);
    }

    #[test]
    fn on_a_phone_a_request_an_arrival_opened_on_a_first_report_opens_again_at_the_next() {
        let mut coalescer = notifying();
        come_to_foreground(
            &mut coalescer,
            &statuses([(RUTH, UnitStatus::never_run())]),
            &[RUTH],
        );
        let running = statuses([(RUTH, running_with(Some(oauth("a"))))]);
        assert_eq!(
            summary(&coalescer.record(&running).opened),
            [(RUTH, oauth_key("a"))]
        );

        let returned = come_to_foreground(&mut coalescer, &running, &[RUTH]);
        assert_eq!(summary(&returned.opened), [(RUTH, oauth_key("a"))]);
    }

    #[test]
    fn on_a_phone_an_arrival_with_nothing_surfaced_and_nothing_on_its_way_up_opens_nothing() {
        let mut coalescer = notifying();
        let running = statuses([
            (RUTH, running_with(None)),
            (
                LAB,
                running_with(Some(oauth_decidable_in_requesting_browser("a"))),
            ),
        ]);
        coalescer.record(&running);

        assert_eq!(
            come_to_foreground(&mut coalescer, &running, &[RUTH, LAB]),
            ConsentNotificationChanges::default()
        );
        let later = coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("b")))),
            (
                LAB,
                running_with(Some(oauth_decidable_in_requesting_browser("a"))),
            ),
        ]));
        assert_eq!(summary(&later.posted), [(RUTH, oauth_key("b"))]);
        assert!(later.opened.is_empty());
    }

    #[test]
    fn on_a_phone_an_arrival_opens_no_request_decided_or_on_a_removed_server() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(Some(oauth("b")))),
        ]));
        let decided = statuses([(RUTH, running_with(None))]);
        coalescer.record(&decided);

        assert_eq!(
            come_to_foreground(&mut coalescer, &decided, &[RUTH]),
            ConsentNotificationChanges::default()
        );
    }

    #[test]
    fn on_a_phone_an_arrival_opens_no_request_the_server_no_longer_has_newest() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(Some(oauth("c")))),
        ]));
        coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("b")))),
            (LAB, running_with(Some(oauth("c")))),
        ]));
        // "b" is decided, and "a" is RUTH's newest again.
        let running = statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(Some(oauth("c")))),
        ]);
        coalescer.record(&running);

        let arrived = come_to_foreground(&mut coalescer, &running, &[RUTH, LAB]);
        assert_eq!(summary(&arrived.opened), [(LAB, oauth_key("c"))]);
    }

    #[test]
    fn on_a_phone_an_arrival_opens_the_request_of_a_run_that_stopped_or_is_stopping() {
        for not_reporting in [UnitStatus::never_run(), not_reporting(RunState::Running)] {
            let mut coalescer = notifying();
            coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
            let away = statuses([(RUTH, not_reporting)]);
            coalescer.record(&away);

            let arrived = come_to_foreground(&mut coalescer, &away, &[RUTH]);
            assert_eq!(summary(&arrived.opened), [(RUTH, oauth_key("a"))]);
            let restarted = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
            assert_eq!(
                restarted,
                ConsentNotificationChanges::default(),
                "the next run's report notifies and opens nothing more"
            );
        }
    }

    #[test]
    fn on_a_phone_an_arrival_opens_no_request_on_a_server_it_doesn_t_run() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        // The Owner turned RUTH off while the app was away.
        let arrived = come_to_foreground(
            &mut coalescer,
            &statuses([
                (RUTH, UnitStatus::never_run()),
                (LAB, UnitStatus::never_run()),
            ]),
            &[LAB],
        );
        assert!(arrived.opened.is_empty());

        let started = coalescer.record(&statuses([
            (RUTH, UnitStatus::never_run()),
            (LAB, running_with(Some(oauth("b")))),
        ]));
        assert_eq!(summary(&started.opened), [(LAB, oauth_key("b"))]);
    }

    #[test]
    fn on_a_phone_an_arrival_that_opens_a_request_awaits_no_first_report() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        let arrived = come_to_foreground(
            &mut coalescer,
            &statuses([
                (RUTH, running_with(Some(oauth("a")))),
                (LAB, UnitStatus::never_run()),
            ]),
            &[RUTH, LAB],
        );
        assert_eq!(summary(&arrived.opened), [(RUTH, oauth_key("a"))]);

        let started = coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(Some(oauth("b")))),
        ]));
        assert_eq!(summary(&started.posted), [(LAB, oauth_key("b"))]);
        assert!(started.opened.is_empty());
    }

    #[test]
    fn on_a_phone_an_arrival_ends_the_earlier_arrival_s_wait_opening_one_request() {
        let mut coalescer = notifying();
        come_to_foreground(
            &mut coalescer,
            &statuses([(RUTH, UnitStatus::never_run())]),
            &[RUTH],
        );

        // RUTH's first report comes in with the next arrival.
        let arrived = come_to_foreground(
            &mut coalescer,
            &statuses([(RUTH, running_with(Some(oauth("a"))))]),
            &[RUTH],
        );
        assert_eq!(summary(&arrived.opened), [(RUTH, oauth_key("a"))]);
        assert!(arrived.posted.is_empty());
    }

    #[test]
    fn on_a_phone_a_first_report_after_the_arrival_s_wait_ends_notifies() {
        let mut coalescer = notifying();
        come_to_foreground(
            &mut coalescer,
            &statuses([(RUTH, UnitStatus::never_run())]),
            &[RUTH],
        );
        coalescer.record(&statuses([(RUTH, not_reporting(RunState::Starting))]));

        // The app left the foreground before RUTH's first report.
        coalescer.end_arrival_wait();
        let reported = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        assert_eq!(summary(&reported.posted), [(RUTH, oauth_key("a"))]);
        assert!(reported.opened.is_empty());
    }

    #[test]
    fn on_a_phone_a_request_decidable_in_its_browser_does_not_open_at_an_arrival() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        let running = statuses([(
            RUTH,
            running_with(Some(oauth_decidable_in_requesting_browser("b"))),
        )]);
        coalescer.record(&running);

        assert_eq!(
            come_to_foreground(&mut coalescer, &running, &[RUTH]),
            ConsentNotificationChanges::default(),
            "nor does the request under it"
        );
    }

    #[test]
    fn on_the_desktop_an_arrival_opens_nothing_more_than_its_statuses_notify() {
        let mut coalescer = ConsentNotificationCoalescer::new(ConsentOpening::AsNotified);
        let running = statuses([(RUTH, running_with(Some(oauth("a"))))]);
        coalescer.record(&running);
        assert_eq!(
            come_to_foreground(&mut coalescer, &running, &[RUTH]),
            ConsentNotificationChanges::default()
        );

        come_to_foreground(
            &mut coalescer,
            &statuses([(RUTH, UnitStatus::never_run())]),
            &[RUTH],
        );
        let reported = coalescer.record(&statuses([(RUTH, running_with(Some(oauth("b"))))]));
        assert_eq!(summary(&reported.posted), [(RUTH, oauth_key("b"))]);
        assert_eq!(reported.opened, reported.posted, "it opens as it notifies");
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
        let mut coalescer = notifying();
        come_to_foreground(
            &mut coalescer,
            &statuses([(RUTH, UnitStatus::never_run())]),
            &[RUTH],
        );
        let start = coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (
                LAB,
                running_with(Some(oauth_decidable_in_requesting_browser("b"))),
            ),
        ]));
        assert!(start.posted.is_empty());
        assert_eq!(summary(&start.opened), [(RUTH, oauth_key("a"))]);
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

    /// The ongoing notification's request's domain and key, and how many
    /// servers it counts.
    fn ongoing_summary(
        coalescer: &ConsentNotificationCoalescer,
    ) -> Option<(String, ConsentKey, usize)> {
        coalescer.ongoing_notification().map(|ongoing| {
            (
                ongoing.newest.domain,
                ongoing.newest.pending_consent.key,
                ongoing.waiting_server_count,
            )
        })
    }

    /// Take down the server `domain`'s own notification, as a tap on it does.
    fn take_down(coalescer: &mut ConsentNotificationCoalescer, domain: &str) {
        coalescer.notification_taken_down(consent_notification_id_for_plugin(domain));
    }

    #[test]
    fn the_ongoing_notification_names_no_request_its_server_s_own_notification_shows() {
        let mut coalescer = notifying();
        assert_eq!(ongoing_summary(&coalescer), None);

        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        assert_eq!(ongoing_summary(&coalescer), None, "RUTH's own shows a");

        take_down(&mut coalescer, RUTH);
        assert_eq!(
            ongoing_summary(&coalescer),
            Some((RUTH.to_owned(), oauth_key("a"), 1)),
            "a tap took RUTH's down"
        );

        coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(Some(device("WXYZ-1234")))),
        ]));
        assert_eq!(
            ongoing_summary(&coalescer),
            Some((RUTH.to_owned(), oauth_key("a"), 2)),
            "LAB's own shows its request, which counts all the same"
        );

        coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("b")))),
            (LAB, running_with(Some(device("WXYZ-1234")))),
        ]));
        assert_eq!(
            ongoing_summary(&coalescer),
            None,
            "RUTH's own shows the newer request"
        );

        coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(Some(device("WXYZ-1234")))),
        ]));
        assert_eq!(
            ongoing_summary(&coalescer),
            Some((RUTH.to_owned(), oauth_key("a"), 2)),
            "b decided brings a back, which notifies no more"
        );

        coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(None)),
        ]));
        assert_eq!(
            ongoing_summary(&coalescer),
            Some((RUTH.to_owned(), oauth_key("a"), 1)),
            "LAB's is decided"
        );

        coalescer.record(&statuses([
            (RUTH, running_with(None)),
            (LAB, running_with(None)),
        ]));
        assert_eq!(ongoing_summary(&coalescer), None);
    }

    #[test]
    fn the_ongoing_notification_names_the_request_seen_latest_of_those_not_shown() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(Some(device("WXYZ-1234")))),
        ]));
        take_down(&mut coalescer, RUTH);
        take_down(&mut coalescer, LAB);
        assert_eq!(
            ongoing_summary(&coalescer),
            Some((LAB.to_owned(), device_key("WXYZ-1234"), 2))
        );
    }

    #[test]
    fn taking_down_a_notification_leaves_the_others_announced() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(Some(oauth("b")))),
        ]));
        take_down(&mut coalescer, RUTH);
        coalescer.notification_taken_down(ongoing_consent_notification_id_for_plugin());
        assert_eq!(
            summary(&coalescer.announced_consents().by_server),
            [(LAB, oauth_key("b"))]
        );

        let decided = coalescer.record(&statuses([
            (RUTH, running_with(None)),
            (LAB, running_with(Some(oauth("b")))),
        ]));
        assert!(
            decided.withdrawn.is_empty(),
            "nothing shows for RUTH to withdraw"
        );
    }

    #[test]
    fn the_ongoing_notification_stays_through_a_run_not_reporting_and_goes_with_a_removed_server() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        take_down(&mut coalescer, RUTH);

        coalescer.record(&statuses([(RUTH, UnitStatus::never_run())]));
        assert_eq!(
            ongoing_summary(&coalescer),
            Some((RUTH.to_owned(), oauth_key("a"), 1))
        );

        coalescer.record(&statuses([]));
        assert_eq!(ongoing_summary(&coalescer), None);
    }

    #[test]
    fn the_ongoing_notification_skips_a_request_the_owner_s_browser_made() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (
                LAB,
                running_with(Some(oauth_decidable_in_requesting_browser("b"))),
            ),
        ]));
        take_down(&mut coalescer, RUTH);
        assert_eq!(
            ongoing_summary(&coalescer),
            Some((RUTH.to_owned(), oauth_key("a"), 1))
        );

        coalescer.record(&statuses([(
            RUTH,
            running_with(Some(oauth_decidable_in_requesting_browser("c"))),
        )]));
        assert_eq!(ongoing_summary(&coalescer), None, "nor one under it");
        assert_eq!(coalescer.pending_server_count(), 1, "the badge counts it");
    }

    #[test]
    fn the_ongoing_notification_names_a_request_an_arrival_opened() {
        let mut coalescer = notifying();
        let arrived = come_to_foreground(
            &mut coalescer,
            &statuses([(RUTH, running_with(Some(oauth("a"))))]),
            &[RUTH],
        );
        assert!(arrived.posted.is_empty());
        assert_eq!(
            ongoing_summary(&coalescer),
            Some((RUTH.to_owned(), oauth_key("a"), 1))
        );
    }

    #[test]
    fn the_announced_consents_name_each_shown_notification_s_request() {
        let mut coalescer = notifying();
        coalescer.record(&statuses([(RUTH, running_with(Some(oauth("a"))))]));
        coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(Some(oauth("b")))),
        ]));
        let announced = coalescer.announced_consents();
        assert_eq!(
            summary(&announced.by_server),
            [(LAB, oauth_key("b")), (RUTH, oauth_key("a"))]
        );
        assert_eq!(announced.ongoing, None, "each shows in its own");

        take_down(&mut coalescer, RUTH);
        coalescer.record(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(None)),
        ]));
        let announced = coalescer.announced_consents();
        assert!(announced.by_server.is_empty());
        assert_eq!(
            announced
                .ongoing
                .map(|request| (request.domain, request.pending_consent.key)),
            Some((RUTH.to_owned(), oauth_key("a")))
        );
    }

    #[test]
    fn a_request_an_arrival_opened_is_announced_by_the_ongoing_notification_only() {
        let mut coalescer = notifying();
        come_to_foreground(
            &mut coalescer,
            &statuses([(RUTH, running_with(Some(oauth("a"))))]),
            &[RUTH],
        );
        let announced = coalescer.announced_consents();
        assert!(announced.by_server.is_empty(), "it didn't notify");
        assert!(announced.ongoing.is_some());
    }
}
