//! [`PendingConsent`], the newest consent waiting on a server as the base
//! receives it in the server's status, and the [`ConsentKey`] that names it,
//! the authorization server's.
//!
//! A server's authorization server publishes the newest of the consents
//! waiting for the Owner, device-code and authorization-code requests alike,
//! as the run's [`ServerDetail::pending_consent`](crate::ServerDetail).
//! On the wire, camelCase:
//!
//! ```json
//! {"kind": "device", "userCode": "ABCD-EFGH", "clientName": "Lifting"}
//! | {"kind": "oauth", "id": "…", "clientName": "Lifting"}
//! ```

use serde::Serialize;
pub use wildflowerhealthio_authorization_server::ConsentKey;
use wildflowerhealthio_authorization_server::NewestPendingConsent;
use wildflowerhealthio_unit_runner::UnitStatus;

use crate::domain::ServerDetail;

/// The newest consent waiting on a server: which request, and the name of the
/// client that asks.
///
/// `Serialize` writes the camelCase shape the [module docs](self) give.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingConsent {
    /// The request.
    #[serde(flatten)]
    pub key: ConsentKey,
    /// The client's registered name, or its `client_id` while it has no
    /// registration.
    pub client_name: String,
    /// Whether the browser that made the request carried the Owner browser
    /// session, so it shows the request's consent card itself. Always `false`
    /// for a device request. Not on the wire: the base shows the request
    /// either way.
    #[serde(skip)]
    pub requested_by_owner_browser: bool,
}

impl PendingConsent {
    /// The newest consent waiting on the server whose status is `unit_status`,
    /// while a run reports one.
    #[must_use]
    pub fn of_run(unit_status: &UnitStatus<ServerDetail>) -> Option<Self> {
        unit_status
            .detail
            .as_ref()?
            .pending_consent
            .clone()
            .map(Self::from)
    }
}

impl From<NewestPendingConsent> for PendingConsent {
    fn from(newest: NewestPendingConsent) -> Self {
        match newest {
            NewestPendingConsent::Device {
                user_code,
                client_name,
            } => Self {
                key: ConsentKey::Device { user_code },
                client_name,
                requested_by_owner_browser: false,
            },
            NewestPendingConsent::OAuth {
                id,
                client_name,
                requested_by_owner_browser,
            } => Self {
                key: ConsentKey::OAuth { id },
                client_name,
                requested_by_owner_browser,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::golden;

    #[test]
    fn the_wire_is_as_the_golden_file_says() {
        let device = PendingConsent::from(NewestPendingConsent::Device {
            user_code: "ABCD-EFGH".to_owned(),
            client_name: "Lifting".to_owned(),
        });
        let oauth = PendingConsent::from(NewestPendingConsent::OAuth {
            id: "req-1".to_owned(),
            client_name: "app-client-id".to_owned(),
            requested_by_owner_browser: false,
        });
        assert_eq!(
            serde_json::to_value([device, oauth]).unwrap(),
            golden()["pendingConsents"]
        );
    }
}
