//! [`PendingConsent`], the oldest consent waiting on a server as the base
//! receives it in the server's status, and the [`ConsentKey`] that names it.
//!
//! A server's authorization server keeps one queue of the consents waiting for
//! the Owner, device-code and authorization-code requests together, oldest
//! first; its head is the run's [`ServerDetail::pending_consent`](crate::ServerDetail).
//! On the wire, camelCase:
//!
//! ```json
//! {"kind": "device", "userCode": "ABCD-EFGH", "clientName": "Lifting"}
//! | {"kind": "oauth", "id": "…", "clientName": "Lifting"}
//! ```

use serde::Serialize;
use wildflowerhealthio_authorization_server::PendingConsentHead;
use wildflowerhealthio_unit_runner::UnitStatus;

use crate::domain::ServerDetail;

/// One consent on a server, by the key its page looks it up by: a
/// device-code request's `user_code`, an authorization-code request's `id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind")]
pub enum ConsentKey {
    /// An RFC 8628 device-code request, decided at the server's device page.
    #[serde(rename = "device", rename_all = "camelCase")]
    Device {
        /// The code the device shows its user.
        user_code: String,
    },
    /// An RFC 6749 §4.1 request an app's `/authorize` parked, decided at its
    /// consent card.
    #[serde(rename = "oauth")]
    OAuth {
        /// The authorization request's id.
        id: String,
    },
}

/// The oldest consent waiting on a server: which request, and the name of the
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
}

impl PendingConsent {
    /// The consent waiting first on the server whose status is `unit_status`,
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

impl From<PendingConsentHead> for PendingConsent {
    fn from(head: PendingConsentHead) -> Self {
        match head {
            PendingConsentHead::Device {
                user_code,
                client_name,
            } => Self {
                key: ConsentKey::Device { user_code },
                client_name,
            },
            PendingConsentHead::OAuth { id, client_name } => Self {
                key: ConsentKey::OAuth { id },
                client_name,
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
        let device = PendingConsent::from(PendingConsentHead::Device {
            user_code: "ABCD-EFGH".to_owned(),
            client_name: "Lifting".to_owned(),
        });
        let oauth = PendingConsent::from(PendingConsentHead::OAuth {
            id: "req-1".to_owned(),
            client_name: "app-client-id".to_owned(),
        });
        assert_eq!(
            serde_json::to_value([device, oauth]).unwrap(),
            golden()["pendingConsents"]
        );
    }
}
