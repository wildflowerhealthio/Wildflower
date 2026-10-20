//! [`PendingConsent`], the newest consent waiting on a server as the base
//! receives it in the server's status, and the [`ConsentKey`] that names it,
//! the authorization server's.
//!
//! A server's authorization server publishes the newest of the consents
//! waiting for the Owner, device-code and authorization-code requests and
//! browser pairings alike, as the run's
//! [`ServerDetail::pending_consent`](crate::ServerDetail). On the wire,
//! camelCase:
//!
//! ```json
//! {"kind": "device", "userCode": "ABCD-EFGH", "requesterName": "Lifting"}
//! | {"kind": "oauth", "id": "…", "requesterName": "Lifting"}
//! | {"kind": "browser", "userCode": "ABCD-EFGH", "requesterName": "Firefox on Linux"}
//! ```

use serde::Serialize;
pub use wildflowerhealthio_authorization_server::ConsentKey;
use wildflowerhealthio_authorization_server::OwnerPrompt;
use wildflowerhealthio_unit_runner::UnitStatus;

use crate::domain::ServerDetail;

/// The newest consent waiting on a server: which request, and the name of
/// what asks.
///
/// `Serialize` writes the camelCase shape the [module docs](self) give.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingConsent {
    /// The request.
    #[serde(flatten)]
    pub key: ConsentKey,
    /// The name of what asks: for a device or an app, its client's
    /// registered name, or its `client_id` while it has no registration; for
    /// a browser pairing, the browser's name. Which it is, the key's kind
    /// says.
    pub requester_name: String,
    /// Whether the request can be decided in the browser that made it, which
    /// carried a browser session that can decide consents, so it shows the
    /// request's consent card itself. Always `false` for a device request or
    /// a browser pairing.
    /// Not on the wire: the base shows the request either way.
    #[serde(skip)]
    pub decidable_in_requesting_browser: bool,
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

impl From<OwnerPrompt> for PendingConsent {
    fn from(newest: OwnerPrompt) -> Self {
        match newest {
            OwnerPrompt::DeviceCode {
                user_code,
                client_name,
            } => Self {
                key: ConsentKey::DeviceCode { user_code },
                requester_name: client_name,
                decidable_in_requesting_browser: false,
            },
            OwnerPrompt::AuthorizationCode {
                id,
                client_name,
                decidable_in_requesting_browser,
            } => Self {
                key: ConsentKey::AuthorizationCode { id },
                requester_name: client_name,
                decidable_in_requesting_browser,
            },
            OwnerPrompt::BrowserPairing {
                user_code,
                browser_name,
            } => Self {
                key: ConsentKey::BrowserPairing { user_code },
                requester_name: browser_name,
                decidable_in_requesting_browser: false,
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
        let device = PendingConsent::from(OwnerPrompt::DeviceCode {
            user_code: "ABCD-EFGH".to_owned(),
            client_name: "Lifting".to_owned(),
        });
        let oauth = PendingConsent::from(OwnerPrompt::AuthorizationCode {
            id: "req-1".to_owned(),
            client_name: "app-client-id".to_owned(),
            decidable_in_requesting_browser: false,
        });
        let browser = PendingConsent::from(OwnerPrompt::BrowserPairing {
            user_code: "WXYZ-BCDF".to_owned(),
            browser_name: "Firefox on Linux".to_owned(),
        });
        assert_eq!(
            serde_json::to_value([device, oauth, browser]).unwrap(),
            golden()["pendingConsents"]
        );
    }
}
