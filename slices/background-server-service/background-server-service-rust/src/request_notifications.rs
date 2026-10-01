//! Coalescing the server's forwarded requests into one notification per caller.
//!
//! Pure: the host feeds it each [`ForwardedRequest`] with the time it arrived,
//! and asks it for the updates that have come due, so the policy is tested
//! against an explicit clock rather than a sleeping one.

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use shared_structures_rust::request_caller::{ForwardedRequest, RequestCaller};

use crate::notification::LocalNotification;

/// How long a caller must go without a request for its next one to count as a
/// new arrival, and the span the request count covers.
pub const REQUEST_WINDOW: Duration = Duration::from_secs(5 * 60);

/// The shortest gap between two notifications for one caller.
pub const REQUEST_UPDATE_INTERVAL: Duration = Duration::from_secs(30);

/// What one caller's notification says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallerActivity {
    /// The caller's first request after [`REQUEST_WINDOW`] without one.
    Arrived { caller: Option<RequestCaller> },
    /// How many requests the caller made in the last [`REQUEST_WINDOW`].
    RecentRequests {
        caller: Option<RequestCaller>,
        count: usize,
    },
}

impl CallerActivity {
    /// The notification for this activity, under the caller's own id
    /// (`server-requests:<caller>`), so each caller's activity replaces its own
    /// notification and never another caller's.
    #[must_use]
    pub fn notification(&self) -> LocalNotification {
        let (caller, body) = match self {
            Self::Arrived { caller } => (
                caller,
                format!(
                    "{} is using your Wildflower server",
                    arrival_subject(caller.as_ref())
                ),
            ),
            Self::RecentRequests { caller, count } => (
                caller,
                format!(
                    "{}: {count} {} in the last 5 min",
                    count_subject(caller.as_ref()),
                    if *count == 1 { "request" } else { "requests" }
                ),
            ),
        };
        LocalNotification {
            id: format!("server-requests:{}", caller_id(caller.as_ref())),
            title: "Wildflower server".to_owned(),
            body,
        }
    }
}

/// The caller's part of its notification id. The kinds are prefixed so an OAuth
/// client and a self-hosted app with the same id never share a notification.
fn caller_id(caller: Option<&RequestCaller>) -> String {
    match caller {
        Some(RequestCaller::OAuthClient { client_id }) => format!("client:{client_id}"),
        Some(RequestCaller::SelfHostedApp { app_id }) => format!("app:{app_id}"),
        None => "unidentified".to_owned(),
    }
}

fn arrival_subject(caller: Option<&RequestCaller>) -> &str {
    match caller {
        Some(RequestCaller::OAuthClient { client_id }) => client_id,
        Some(RequestCaller::SelfHostedApp { app_id }) => app_id,
        None => "An unidentified caller",
    }
}

fn count_subject(caller: Option<&RequestCaller>) -> &str {
    match caller {
        Some(RequestCaller::OAuthClient { client_id }) => client_id,
        Some(RequestCaller::SelfHostedApp { app_id }) => app_id,
        None => "Unidentified callers",
    }
}

/// One caller's requests inside the window and when it was last notified.
#[derive(Debug)]
struct CallerRequests {
    /// Arrival times, oldest first, none older than [`REQUEST_WINDOW`] before
    /// the latest pruning.
    arrived_at: VecDeque<Instant>,
    last_notified_at: Instant,
    /// A request arrived since the last notification, which an update owes.
    update_owed: bool,
}

impl CallerRequests {
    /// Drop the arrivals that fell out of the window ending at `now`.
    fn forget_before_window(&mut self, now: Instant) {
        let Some(window_start) = now.checked_sub(REQUEST_WINDOW) else {
            return;
        };
        while self
            .arrived_at
            .front()
            .is_some_and(|arrived_at| *arrived_at < window_start)
        {
            self.arrived_at.pop_front();
        }
    }

    fn update_due_at(&self) -> Instant {
        self.last_notified_at + REQUEST_UPDATE_INTERVAL
    }
}

/// The per-caller request notification policy.
///
/// Each caller (an OAuth client, a self-hosted app, or the unidentified
/// callers as one group of their own) has one notification. The first request
/// after [`REQUEST_WINDOW`] without one notifies at once ([`CallerActivity::Arrived`]).
/// Later requests update the count ([`CallerActivity::RecentRequests`]) at most
/// once per [`REQUEST_UPDATE_INTERVAL`]: one arriving sooner is owed an update,
/// which [`Self::take_due_updates`] hands out once the interval has passed.
#[derive(Debug, Default)]
pub struct RequestNotificationCoalescer {
    callers: HashMap<Option<RequestCaller>, CallerRequests>,
}

impl RequestNotificationCoalescer {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Count `request`, which arrived at `now`, returning the notification it
    /// warrants right away, if any. `now` must not go backwards across calls.
    pub fn record(&mut self, request: ForwardedRequest, now: Instant) -> Option<CallerActivity> {
        let caller = request.caller;
        let Some(requests) = self.callers.get_mut(&caller) else {
            self.callers.insert(caller.clone(), first_request(now));
            return Some(CallerActivity::Arrived { caller });
        };
        requests.forget_before_window(now);
        if requests.arrived_at.is_empty() {
            *requests = first_request(now);
            return Some(CallerActivity::Arrived { caller });
        }
        requests.arrived_at.push_back(now);
        if now >= requests.update_due_at() {
            requests.last_notified_at = now;
            requests.update_owed = false;
            return Some(CallerActivity::RecentRequests {
                count: requests.arrived_at.len(),
                caller,
            });
        }
        requests.update_owed = true;
        None
    }

    /// The earliest time an owed update comes due, or `None` when none is owed.
    #[must_use]
    pub fn next_update_due_at(&self) -> Option<Instant> {
        self.callers
            .values()
            .filter(|requests| requests.update_owed)
            .map(CallerRequests::update_due_at)
            .min()
    }

    /// The owed updates that are due at `now`, each with its caller's count
    /// over the window ending at `now`. Callers with nothing in the window and
    /// nothing owed are forgotten.
    pub fn take_due_updates(&mut self, now: Instant) -> Vec<CallerActivity> {
        let mut due_updates = Vec::new();
        self.callers.retain(|caller, requests| {
            requests.forget_before_window(now);
            if requests.update_owed && now >= requests.update_due_at() {
                requests.last_notified_at = now;
                requests.update_owed = false;
                due_updates.push(CallerActivity::RecentRequests {
                    caller: caller.clone(),
                    count: requests.arrived_at.len(),
                });
            }
            requests.update_owed || !requests.arrived_at.is_empty()
        });
        due_updates
    }
}

fn first_request(now: Instant) -> CallerRequests {
    CallerRequests {
        arrived_at: VecDeque::from([now]),
        last_notified_at: now,
        update_owed: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn app(app_id: &str) -> Option<RequestCaller> {
        Some(RequestCaller::SelfHostedApp {
            app_id: app_id.to_owned(),
        })
    }

    fn request(caller: Option<RequestCaller>) -> ForwardedRequest {
        ForwardedRequest { caller }
    }

    #[test]
    fn notifications_name_the_caller_and_keep_kinds_apart() {
        let client = Some(RequestCaller::OAuthClient {
            client_id: "lifting".to_owned(),
        });
        assert_eq!(
            CallerActivity::Arrived {
                caller: client.clone()
            }
            .notification(),
            LocalNotification {
                id: "server-requests:client:lifting".to_owned(),
                title: "Wildflower server".to_owned(),
                body: "lifting is using your Wildflower server".to_owned(),
            }
        );
        assert_eq!(
            CallerActivity::RecentRequests {
                caller: app("lifting"),
                count: 42
            }
            .notification(),
            LocalNotification {
                id: "server-requests:app:lifting".to_owned(),
                title: "Wildflower server".to_owned(),
                body: "lifting: 42 requests in the last 5 min".to_owned(),
            }
        );
        assert_eq!(
            CallerActivity::RecentRequests {
                caller: None,
                count: 1
            }
            .notification()
            .body,
            "Unidentified callers: 1 request in the last 5 min"
        );
        assert_eq!(
            CallerActivity::Arrived { caller: None }.notification().id,
            "server-requests:unidentified"
        );
    }

    #[test]
    fn a_burst_notifies_once_then_updates_after_the_interval() {
        let start = Instant::now();
        let mut coalescer = RequestNotificationCoalescer::new();
        assert_eq!(
            coalescer.record(request(app("lifting")), start),
            Some(CallerActivity::Arrived {
                caller: app("lifting")
            })
        );
        for second in 1..=3 {
            assert_eq!(
                coalescer.record(request(app("lifting")), start + Duration::from_secs(second)),
                None
            );
        }
        assert_eq!(
            coalescer.next_update_due_at(),
            Some(start + REQUEST_UPDATE_INTERVAL)
        );
        assert_eq!(
            coalescer.take_due_updates(start + Duration::from_secs(29)),
            Vec::new()
        );
        assert_eq!(
            coalescer.take_due_updates(start + REQUEST_UPDATE_INTERVAL),
            vec![CallerActivity::RecentRequests {
                caller: app("lifting"),
                count: 4
            }]
        );
        assert_eq!(coalescer.next_update_due_at(), None);
    }

    /// One "event" of the simulated clock: a request from `caller` at `at_ms`.
    #[derive(Debug, Clone)]
    struct Arrival {
        caller: Option<RequestCaller>,
        at_ms: u64,
    }

    /// The callers the properties draw from: two apps, a client with an app's
    /// id, and the unidentified group.
    fn caller() -> impl Strategy<Value = Option<RequestCaller>> {
        prop_oneof![
            Just(app("lifting")),
            Just(app("viewer")),
            Just(Some(RequestCaller::OAuthClient {
                client_id: "lifting".to_owned()
            })),
            Just(None),
        ]
    }

    /// Arrivals in time order, with gaps from a few milliseconds to more than a
    /// window, so bursts, slow trickles and quiet spells all occur.
    fn arrivals() -> impl Strategy<Value = Vec<Arrival>> {
        proptest::collection::vec(
            (
                caller(),
                prop_oneof![0_u64..2_000, 0_u64..60_000, 0_u64..700_000],
            ),
            0..60,
        )
        .prop_map(|steps| {
            let mut at_ms = 0;
            steps
                .into_iter()
                .map(|(caller, gap_ms)| {
                    at_ms += gap_ms;
                    Arrival { caller, at_ms }
                })
                .collect()
        })
    }

    /// One notification the simulated host posted.
    #[derive(Debug, Clone, PartialEq)]
    struct Posted {
        at: Instant,
        /// How many of the arrivals had been recorded when it was posted —
        /// arrivals can share an instant, so the time alone doesn't say which
        /// of them it counts.
        arrivals_recorded: usize,
        activity: CallerActivity,
    }

    /// Drive a coalescer through `arrivals` the way the host does: hand out
    /// every update that comes due before each arrival, then record it, then
    /// drain the updates still owed.
    fn simulate(start: Instant, arrivals: &[Arrival]) -> Vec<Posted> {
        fn drain_due(
            coalescer: &mut RequestNotificationCoalescer,
            until: Option<Instant>,
            arrivals_recorded: usize,
            posted: &mut Vec<Posted>,
        ) {
            while let Some(due_at) = coalescer.next_update_due_at() {
                if until.is_some_and(|until| due_at > until) {
                    break;
                }
                for activity in coalescer.take_due_updates(due_at) {
                    posted.push(Posted {
                        at: due_at,
                        arrivals_recorded,
                        activity,
                    });
                }
            }
        }

        let mut coalescer = RequestNotificationCoalescer::new();
        let mut posted = Vec::new();
        for (index, arrival) in arrivals.iter().enumerate() {
            let now = start + Duration::from_millis(arrival.at_ms);
            drain_due(&mut coalescer, Some(now), index, &mut posted);
            if let Some(activity) = coalescer.record(request(arrival.caller.clone()), now) {
                posted.push(Posted {
                    at: now,
                    arrivals_recorded: index + 1,
                    activity,
                });
            }
        }
        drain_due(&mut coalescer, None, arrivals.len(), &mut posted);
        posted
    }

    fn caller_of(activity: &CallerActivity) -> &Option<RequestCaller> {
        match activity {
            CallerActivity::Arrived { caller } | CallerActivity::RecentRequests { caller, .. } => {
                caller
            }
        }
    }

    /// `caller`'s notifications, as times and activities (the recorded-arrival
    /// counts differ between a full run and a run of one caller alone).
    fn only_caller(
        posted: &[Posted],
        caller: &Option<RequestCaller>,
    ) -> Vec<(Instant, CallerActivity)> {
        posted
            .iter()
            .filter(|posted| caller_of(&posted.activity) == caller)
            .map(|posted| (posted.at, posted.activity.clone()))
            .collect()
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(256))]

        /// One caller is never notified twice within the update interval.
        #[test]
        fn a_caller_is_notified_at_most_once_per_interval(arrivals in arrivals()) {
            let posted = simulate(Instant::now(), &arrivals);
            for caller in arrivals.iter().map(|arrival| &arrival.caller) {
                let times: Vec<Instant> = only_caller(&posted, caller)
                    .into_iter()
                    .map(|(at, _)| at)
                    .collect();
                for pair in times.windows(2) {
                    prop_assert!(pair[1] - pair[0] >= REQUEST_UPDATE_INTERVAL);
                }
            }
        }

        /// A request after a window without one from its caller is announced
        /// the moment it arrives; any other request is not announced as new.
        #[test]
        fn an_arrival_after_a_quiet_window_is_announced_at_once(arrivals in arrivals()) {
            let start = Instant::now();
            let posted = simulate(start, &arrivals);
            for (index, arrival) in arrivals.iter().enumerate() {
                let now = start + Duration::from_millis(arrival.at_ms);
                let quiet = !arrivals[..index].iter().any(|earlier| {
                    earlier.caller == arrival.caller
                        && start + Duration::from_millis(earlier.at_ms) + REQUEST_WINDOW >= now
                });
                let announced = posted.iter().any(|posted| {
                    posted.arrivals_recorded == index + 1
                        && posted.activity
                            == CallerActivity::Arrived { caller: arrival.caller.clone() }
                });
                prop_assert_eq!(announced, quiet);
            }
        }

        /// Every count is the caller's requests in the window ending at that
        /// notification, and no request goes unreported: each caller's last
        /// notification comes at or after its last request.
        #[test]
        fn counts_cover_the_window_and_every_request_is_reported(arrivals in arrivals()) {
            let start = Instant::now();
            let posted = simulate(start, &arrivals);
            for posted in &posted {
                if let CallerActivity::RecentRequests { caller, count } = &posted.activity {
                    let in_window = arrivals[..posted.arrivals_recorded]
                        .iter()
                        .filter(|arrival| {
                            let arrived_at = start + Duration::from_millis(arrival.at_ms);
                            arrival.caller == *caller && arrived_at + REQUEST_WINDOW >= posted.at
                        })
                        .count();
                    prop_assert_eq!(*count, in_window);
                }
            }
            for arrival in &arrivals {
                let last_request = arrivals
                    .iter()
                    .filter(|other| other.caller == arrival.caller)
                    .map(|other| start + Duration::from_millis(other.at_ms))
                    .max();
                let last_notification = only_caller(&posted, &arrival.caller)
                    .into_iter()
                    .map(|(at, _)| at)
                    .max();
                prop_assert!(last_notification >= last_request);
            }
        }

        /// Callers never affect each other's notifications — in particular the
        /// unidentified group is never merged with an identified caller.
        #[test]
        fn callers_are_coalesced_independently(arrivals in arrivals()) {
            let start = Instant::now();
            let posted = simulate(start, &arrivals);
            for caller in arrivals.iter().map(|arrival| &arrival.caller) {
                let alone: Vec<Arrival> = arrivals
                    .iter()
                    .filter(|arrival| arrival.caller == *caller)
                    .cloned()
                    .collect();
                prop_assert_eq!(
                    only_caller(&posted, caller),
                    only_caller(&simulate(start, &alone), caller)
                );
            }
        }
    }
}
