//! [`NewestPendingConsent`] — which pending authorization request the host is
//! currently asking the Owner to decide: the newest, across both grant flows
//! and browser pairings;
//! see `slices/authorization/docs/Jargon Explanation.md` ("Pending consents")
//! for how the host learns of it. And [`ConsentKey`], which names one request
//! by the key its consent surface looks it up by, and answers whether it is
//! still pending.

use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::domain::authorization_request::{AuthorizationRequest, RequestKind};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::grant_store::{AuthorizationRequestsTx as _, ClientsTx};
use crate::domain::GrantStore;

/// The newest pending authorization request, or absent when nothing is
/// pending.
///
/// A request whose client is disabled is not a pending consent: its consent
/// prompt answers not found, so the host is never asked about it (a client
/// with no row, trusted on first use, stays a candidate). The store's
/// `newest_pending_consent`, `ConsentKey::is_pending_in` and raising a
/// prompt for the Owner all apply this rule through
/// `client_is_disabled`.
///
/// Discriminated because the flows share no lookup key, nor what asks: each
/// variant carries the key its consent surface already fetches by, and the
/// name of what asks, for the host's notification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NewestPendingConsent {
    /// An RFC 8628 device-code request. Decided at the device page,
    /// `/oauth/device?user_code=…`.
    Device {
        /// The pairing code the device shows its user.
        user_code: String,
        /// The name of the client that asks: its registered name, or its
        /// `client_id` while it has no registration, as the consent card
        /// names it.
        client_name: String,
    },
    /// An RFC 6749 §4.1 request parked by `/oauth/authorize` awaiting Owner
    /// approval. Decided at its consent card, `/oauth/authorize/{id}/consent`.
    OAuth {
        /// The `AuthorizationRequest` primary key, which is also the `$id` of
        /// the wait page the requesting browser is sitting on.
        id: String,
        /// The name of the client that asks, as for
        /// [`Device`](Self::Device).
        client_name: String,
        /// Whether the request can be decided in the browser that made it,
        /// which carried a browser session that can decide consents, so it
        /// shows the request's consent card itself.
        decidable_in_requesting_browser: bool,
    },
    /// A browser pairing: a browser that wants a browser session. Decided at
    /// the device page, `/oauth/device?user_code=…`, like a device. The
    /// browser is always remote: a browser on the server's own device signs
    /// in with a same-device sign-in instead.
    BrowserPairing {
        /// The code the pairing page shows.
        user_code: String,
        /// The name the browser goes by: one it gave itself, or one taken
        /// from its user agent.
        browser_name: String,
    },
}

impl NewestPendingConsent {
    /// How the host asks the Owner about `request`, whose client's registered
    /// name is `registered_client_name` (`None` for a client trusted on first
    /// use that has no registration yet, which goes by its `client_id`, as the
    /// consent card names it).
    #[must_use]
    pub fn for_request(
        request: &AuthorizationRequest,
        registered_client_name: Option<String>,
    ) -> Self {
        let client_name = registered_client_name.unwrap_or_else(|| request.client_id().to_owned());
        match request.kind() {
            RequestKind::AuthorizationCode(code_request) => NewestPendingConsent::OAuth {
                id: request.id().to_owned(),
                client_name,
                decidable_in_requesting_browser: code_request.decidable_in_requesting_browser,
            },
            RequestKind::DeviceCode(device_request) => NewestPendingConsent::Device {
                user_code: device_request.user_code.clone(),
                client_name,
            },
            RequestKind::BrowserPairing(pairing_request) => NewestPendingConsent::BrowserPairing {
                user_code: pairing_request.user_code.clone(),
                browser_name: pairing_request.browser_name.clone(),
            },
        }
    }
}

/// One authorization request, by the key its consent surface looks it up by:
/// a device-code request's or browser pairing's `user_code`, an
/// authorization-code request's `id`.
///
/// `Serialize` writes the shape the host's server status carries it in,
/// `{"kind": "device", "userCode": …}`, `{"kind": "browser", "userCode": …}`
/// or `{"kind": "oauth", "id": …}`.
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
    /// A browser pairing, decided at the server's device page like a device.
    #[serde(rename = "browser", rename_all = "camelCase")]
    Browser {
        /// The code the pairing page shows.
        user_code: String,
    },
}

impl ConsentKey {
    /// Whether the request this key names still waits for the Owner in
    /// `store` at `now`: pending, not past its expiry, and its client not
    /// disabled (the rule on [`NewestPendingConsent`]). A request that isn't
    /// there, or is decided or expired, doesn't.
    ///
    /// # Errors
    ///
    /// The store's, when reading the request fails.
    pub(crate) fn is_pending_in(
        &self,
        store: &impl GrantStore,
        now: DateTime<Utc>,
    ) -> Result<bool, AuthorizationServerError> {
        store.read(|tx| {
            let request = match self {
                Self::Device { user_code } | Self::Browser { user_code } => {
                    tx.pending_authorization_request_by_user_code(user_code)?
                }
                Self::OAuth { id } => tx.authorization_request_by_id(id)?,
            };
            match request {
                Some(request) if request.pending_at(now) => {
                    Ok(!client_is_disabled(tx, request.client_id())?)
                }
                _ => Ok(false),
            }
        })
    }
}

/// Whether `client_id`'s client is disabled, by the rule on
/// [`NewestPendingConsent`]: a client with no row is not.
///
/// # Errors
///
/// The store's, when reading the client fails.
pub(crate) fn client_is_disabled(
    tx: &mut impl ClientsTx,
    client_id: &str,
) -> Result<bool, AuthorizationServerError> {
    Ok(tx
        .client_by_id(client_id)?
        .is_some_and(|client| client.disabled_at.is_some()))
}

#[cfg(test)]
mod tests {
    use crate::domain::grant_store::*;
    use chrono::Duration;

    use super::*;
    use crate::domain::authorization_request::RequestStatus;
    use crate::domain::test_fake::{code_request, device_request, FakeGrantStore};

    fn oauth(id: &str) -> ConsentKey {
        ConsentKey::OAuth { id: id.to_owned() }
    }

    fn device(user_code: &str) -> ConsentKey {
        ConsentKey::Device {
            user_code: user_code.to_owned(),
        }
    }

    #[test]
    fn a_request_is_pending_until_it_is_decided_or_expires() {
        let store = FakeGrantStore::default();
        let now = Utc::now();
        for (id, status, expires_at) in [
            (
                "waiting",
                RequestStatus::Pending,
                now + Duration::minutes(5),
            ),
            ("stale", RequestStatus::Pending, now - Duration::minutes(1)),
            (
                "approved",
                RequestStatus::Approved,
                now + Duration::minutes(5),
            ),
            ("denied", RequestStatus::Denied, now + Duration::minutes(5)),
        ] {
            store
                .tx()
                .insert_authorization_request(&code_request(id, status, expires_at))
                .unwrap();
        }
        store
            .tx()
            .insert_authorization_request(&device_request(
                "device-waiting",
                "ABCD-EFGH",
                RequestStatus::Pending,
            ))
            .unwrap();
        store
            .tx()
            .insert_authorization_request(&device_request(
                "device-denied",
                "WXYZ-WXYZ",
                RequestStatus::Denied,
            ))
            .unwrap();

        let pending = |key: ConsentKey| key.is_pending_in(&store, now).unwrap();
        assert!(pending(oauth("waiting")));
        assert!(pending(device("ABCD-EFGH")));
        assert!(!pending(oauth("stale")));
        assert!(!pending(oauth("approved")));
        assert!(!pending(oauth("denied")));
        assert!(!pending(device("WXYZ-WXYZ")));
        assert!(!pending(oauth("ghost")));
        assert!(!pending(device("GHST-GHST")));
    }

    /// A disabled client's request is no pending consent: the fake's
    /// `newest_pending_consent` skips it, as the SQL does, and its key isn't
    /// pending; a client with no row stays a candidate.
    #[test]
    fn a_disabled_client_s_request_is_no_pending_consent() {
        use crate::domain::client::Client;
        use crate::domain::test_fake::{client, code_request_for};

        let store = FakeGrantStore::default();
        let now = Utc::now();
        store
            .tx()
            .insert_authorization_request(&code_request_for(
                "unregistered",
                "stranger",
                vec!["read".to_owned()],
            ))
            .unwrap();
        assert!(oauth("unregistered").is_pending_in(&store, now).unwrap());
        store
            .tx()
            .upsert_client(&Client {
                disabled_at: Some(now),
                ..client("disabled-app", &["read"])
            })
            .unwrap();
        store
            .tx()
            .insert_authorization_request(&code_request_for(
                "disabled",
                "disabled-app",
                vec!["read".to_owned()],
            ))
            .unwrap();
        assert!(!oauth("disabled").is_pending_in(&store, now).unwrap());
        assert!(matches!(
            store.tx().newest_pending_consent(now).unwrap(),
            Some(NewestPendingConsent::OAuth { id, .. }) if id == "unregistered"
        ));
    }
}
