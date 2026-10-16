//! [`pending_consent_server_count`], how many servers have a consent waiting
//! on them, out of `UnitRunner`'s statuses: what the app icon's badge shows.

use wildflowerhealthio_unit_runner::UnitStatuses;

use crate::domain::ServerDetail;

/// How many of the servers in `statuses` have a consent waiting on their
/// run, as their [`ServerDetail::pending_consent`] says.
///
/// A server's status carries only its newest pending consent, so a server
/// with several waiting counts once. A request the Owner's own browser made
/// counts too: it is waiting all the same. A run that isn't reporting, as
/// while it stops or starts, has none to count.
#[must_use]
pub fn pending_consent_server_count(statuses: &UnitStatuses<ServerDetail>) -> usize {
    statuses
        .values()
        .filter(|unit_status| {
            unit_status
                .detail
                .as_ref()
                .is_some_and(|detail| detail.pending_consent.is_some())
        })
        .count()
}

#[cfg(test)]
mod tests {
    use wildflowerhealthio_authorization_server::NewestPendingConsent;
    use wildflowerhealthio_unit_runner::{RunState, UnitId, UnitStatus};

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
                consent_watcher: None,
            }),
        }
    }

    fn not_reporting() -> UnitStatus<ServerDetail> {
        UnitStatus {
            run_state: RunState::Starting,
            running_since: None,
            detail: None,
        }
    }

    fn oauth(id: &str, requested_by_owner_browser: bool) -> NewestPendingConsent {
        NewestPendingConsent::OAuth {
            id: id.to_owned(),
            client_name: "Lifting".to_owned(),
            requested_by_owner_browser,
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

    #[test]
    fn no_servers_count_none() {
        assert_eq!(pending_consent_server_count(&statuses([])), 0);
    }

    #[test]
    fn each_server_with_a_consent_waiting_counts_once() {
        let count = pending_consent_server_count(&statuses([
            (RUTH, running_with(Some(oauth("a", false)))),
            (LAB, running_with(Some(device("WXYZ-1234")))),
        ]));
        assert_eq!(count, 2);
    }

    #[test]
    fn a_server_with_nothing_waiting_or_not_reporting_does_not_count() {
        let count = pending_consent_server_count(&statuses([
            (RUTH, running_with(None)),
            (LAB, not_reporting()),
        ]));
        assert_eq!(count, 0);
    }

    #[test]
    fn a_request_the_owners_browser_made_counts() {
        let count =
            pending_consent_server_count(&statuses([(RUTH, running_with(Some(oauth("a", true))))]));
        assert_eq!(count, 1);
    }
}
