//! [`PendingConsent`], the oldest consent waiting on a server as the base
//! receives it, the [`ConsentKey`] that names a consent, and
//! [`PendingConsentTracker`], which picks the servers whose waiting consent
//! changed out of `UnitRunner`'s statuses.
//!
//! A server's gatekeeper keeps one queue of the consents waiting for the
//! Owner, device-code and authorization-code requests together, oldest
//! first; its head is the run's [`ServerDetail::pending_consent`]. On the
//! wire, camelCase, the head left out when nothing waits:
//!
//! ```json
//! {
//!   "domain": "ruth.relay.example.com",
//!   "head": {"kind": "device", "userCode": "ABCD-EFGH"}
//!         | {"kind": "oauth", "id": "…"}
//! }
//! ```

use std::collections::BTreeMap;

use gatekeeper_rust::PendingConsentHead;
use serde::{Deserialize, Serialize};
use unit_runner_rust::{UnitId, UnitStatus, UnitStatuses};

use crate::domain::ServerDetail;

/// One consent on a server, by the key its flow looks it up by: a
/// device-code request's `user_code`, an authorization-code request's `id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum ConsentKey {
    /// An RFC 8628 device-code request.
    #[serde(rename = "device", rename_all = "camelCase")]
    Device {
        /// The code the device shows its user.
        user_code: String,
    },
    /// An RFC 6749 §4.1 request an app's `/authorize` parked.
    #[serde(rename = "oauth")]
    OAuth {
        /// The authorization request's id.
        id: String,
    },
}

impl From<PendingConsentHead> for ConsentKey {
    fn from(head: PendingConsentHead) -> Self {
        match head {
            PendingConsentHead::Device { user_code } => Self::Device { user_code },
            PendingConsentHead::OAuth { id } => Self::OAuth { id },
        }
    }
}

/// The oldest consent waiting on the server `domain`, or `None` when nothing
/// waits there, which includes a server that isn't running.
///
/// `Serialize` writes the camelCase shape the [module docs](self) give.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PendingConsent {
    /// The server's domain, its unit id.
    pub domain: String,
    /// The head of the server's queue.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<ConsentKey>,
}

impl PendingConsent {
    /// The servers in `statuses` with a consent waiting, in domain order.
    #[must_use]
    pub fn waiting(statuses: &UnitStatuses<ServerDetail>) -> Vec<Self> {
        statuses
            .iter()
            .filter_map(|(unit_id, unit_status)| {
                head_of(unit_status).map(|head| Self {
                    domain: unit_id.as_str().to_owned(),
                    head: Some(head.clone().into()),
                })
            })
            .collect()
    }
}

/// A server whose waiting consent changed, and whether nothing waited there
/// before, which is when the host brings its window forward.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingConsentChange {
    /// The server's waiting consent now.
    pub pending_consent: PendingConsent,
    /// Whether the server had no consent waiting before this one.
    pub newly_waiting: bool,
}

/// Picks the servers whose waiting consent changed out of `UnitRunner`'s
/// statuses, so the host sends the base one [`PendingConsent`] per change.
///
/// A server whose run ends, or that is removed, had its consent cleared, so
/// it is sent with no head once. The first read sends only the servers with
/// a consent waiting.
#[derive(Debug, Default)]
pub struct PendingConsentTracker {
    last_sent: BTreeMap<UnitId, PendingConsentHead>,
}

impl PendingConsentTracker {
    /// A tracker that has sent nothing.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The servers whose head in `statuses` differs from the one last
    /// returned for them, in domain order, removed servers among them.
    pub fn changed_pending_consents(
        &mut self,
        statuses: &UnitStatuses<ServerDetail>,
    ) -> Vec<PendingConsentChange> {
        let heads: BTreeMap<UnitId, PendingConsentHead> = statuses
            .iter()
            .filter_map(|(unit_id, unit_status)| {
                head_of(unit_status).map(|head| (unit_id.clone(), head.clone()))
            })
            .collect();
        let mut domains: Vec<&UnitId> = heads.keys().chain(self.last_sent.keys()).collect();
        domains.sort();
        domains.dedup();
        let changed = domains
            .into_iter()
            .filter(|unit_id| heads.get(*unit_id) != self.last_sent.get(*unit_id))
            .map(|unit_id| PendingConsentChange {
                pending_consent: PendingConsent {
                    domain: unit_id.as_str().to_owned(),
                    head: heads.get(unit_id).cloned().map(ConsentKey::from),
                },
                newly_waiting: !self.last_sent.contains_key(unit_id),
            })
            .collect();
        self.last_sent = heads;
        changed
    }
}

/// The head of the server's queue while a run reports one.
fn head_of(unit_status: &UnitStatus<ServerDetail>) -> Option<&PendingConsentHead> {
    unit_status
        .detail
        .as_ref()
        .and_then(|detail| detail.pending_consent.as_ref())
}

#[cfg(test)]
mod tests {
    use unit_runner_rust::RunState;

    use super::*;
    use crate::domain::server_status::tests::{golden, LAB, RUTH};

    fn running_with(pending_consent: Option<PendingConsentHead>) -> UnitStatus<ServerDetail> {
        UnitStatus {
            run_state: RunState::Running,
            running_since: None,
            detail: Some(ServerDetail {
                health: None,
                certificate: None,
                pending_consent,
                consent_decider: None,
                launch_minter: None,
            }),
        }
    }

    fn device(user_code: &str) -> PendingConsentHead {
        PendingConsentHead::Device {
            user_code: user_code.to_owned(),
        }
    }

    fn oauth(id: &str) -> PendingConsentHead {
        PendingConsentHead::OAuth { id: id.to_owned() }
    }

    fn statuses(
        entries: impl IntoIterator<Item = (&'static str, UnitStatus<ServerDetail>)>,
    ) -> UnitStatuses<ServerDetail> {
        entries
            .into_iter()
            .map(|(domain, status)| (UnitId::from(domain), status))
            .collect()
    }

    /// `(domain, head, newly_waiting)` of each change, to compare at a glance.
    fn summary(changes: &[PendingConsentChange]) -> Vec<(&str, Option<ConsentKey>, bool)> {
        changes
            .iter()
            .map(|change| {
                (
                    change.pending_consent.domain.as_str(),
                    change.pending_consent.head.clone(),
                    change.newly_waiting,
                )
            })
            .collect()
    }

    #[test]
    fn the_wire_is_as_the_golden_file_says() {
        let golden = golden();
        let waiting = PendingConsent {
            domain: RUTH.to_owned(),
            head: Some(device("ABCD-EFGH").into()),
        };
        let parked = PendingConsent {
            domain: LAB.to_owned(),
            head: Some(oauth("req-1").into()),
        };
        let nothing_waiting = PendingConsent {
            domain: RUTH.to_owned(),
            head: None,
        };
        assert_eq!(
            serde_json::to_value([waiting, parked, nothing_waiting]).unwrap(),
            golden["pendingConsents"]
        );
        let keys: Vec<ConsentKey> = serde_json::from_value(golden["consentKeys"].clone()).unwrap();
        assert_eq!(keys, [device("ABCD-EFGH").into(), oauth("req-1").into()]);
    }

    #[test]
    fn waiting_lists_only_the_servers_with_a_head() {
        let waiting = PendingConsent::waiting(&statuses([
            (RUTH, running_with(Some(device("ABCD-EFGH")))),
            (LAB, running_with(None)),
            ("idle.relay.example.com", UnitStatus::never_run()),
        ]));
        assert_eq!(
            waiting,
            [PendingConsent {
                domain: RUTH.to_owned(),
                head: Some(device("ABCD-EFGH").into()),
            }]
        );
    }

    #[test]
    fn the_first_read_sends_only_the_servers_with_a_head() {
        let mut tracker = PendingConsentTracker::new();
        let changes = tracker.changed_pending_consents(&statuses([
            (RUTH, running_with(Some(device("ABCD-EFGH")))),
            (LAB, running_with(None)),
        ]));
        assert_eq!(
            summary(&changes),
            [(RUTH, Some(device("ABCD-EFGH").into()), true)]
        );
    }

    #[test]
    fn a_new_head_is_sent_and_only_the_first_is_newly_waiting() {
        let mut tracker = PendingConsentTracker::new();
        tracker.changed_pending_consents(&statuses([(RUTH, running_with(Some(oauth("a"))))]));

        let changes =
            tracker.changed_pending_consents(&statuses([(RUTH, running_with(Some(oauth("b"))))]));
        assert_eq!(summary(&changes), [(RUTH, Some(oauth("b").into()), false)]);

        let unchanged =
            tracker.changed_pending_consents(&statuses([(RUTH, running_with(Some(oauth("b"))))]));
        assert!(unchanged.is_empty());
    }

    #[test]
    fn a_cleared_stopped_or_removed_server_is_sent_with_no_head_once() {
        let mut tracker = PendingConsentTracker::new();
        tracker.changed_pending_consents(&statuses([
            (RUTH, running_with(Some(oauth("a")))),
            (LAB, running_with(Some(device("LAB-CODE")))),
            ("third.relay.example.com", running_with(Some(oauth("c")))),
        ]));

        let changes = tracker.changed_pending_consents(&statuses([
            (RUTH, running_with(None)),
            (LAB, UnitStatus::never_run()),
        ]));
        assert_eq!(
            summary(&changes),
            [
                (LAB, None, false),
                (RUTH, None, false),
                ("third.relay.example.com", None, false),
            ]
        );
        assert!(tracker
            .changed_pending_consents(&statuses([(RUTH, running_with(None))]))
            .is_empty());

        let again =
            tracker.changed_pending_consents(&statuses([(RUTH, running_with(Some(oauth("d"))))]));
        assert_eq!(summary(&again), [(RUTH, Some(oauth("d").into()), true)]);
    }
}
