//! [`NewestPendingConsent`] — which pending authorization request the host is
//! currently asking the Owner to decide: the newest, across both grant flows;
//! see `slices/authorization/docs/Jargon Explanation.md` ("Pending consents")
//! for how the host learns of it. And [`ConsentKey`], which names one request
//! by the key its consent surface looks it up by, and answers whether it is
//! still pending.

use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::domain::authorization_request::RequestStatus;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::GrantStore;

/// The newest pending authorization request, or absent when nothing is
/// pending.
///
/// Discriminated because the two flows share no lookup key: each variant
/// carries the one its consent surface already fetches by, and the name of
/// the client that asks, for the host's notification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NewestPendingConsent {
    /// An RFC 8628 device-code request. Decided at the device page,
    /// `/oauth/device?user_code=…`.
    Device {
        /// The pairing code the device shows its user. Never `NULL` in the
        /// row — the query skips a device row missing one rather than
        /// surfacing an unfetchable key.
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
}

/// One authorization request, by the key its consent surface looks it up by:
/// a device-code request's `user_code`, an authorization-code request's `id`.
///
/// `Serialize` writes the shape the host's server status carries it in,
/// `{"kind": "device", "userCode": …}` or `{"kind": "oauth", "id": …}`.
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

impl ConsentKey {
    /// Whether the request this key names still waits for the Owner in
    /// `store` at `now`: pending, and not past its expiry. A request that
    /// isn't there, or is decided or expired, doesn't.
    ///
    /// # Errors
    ///
    /// The store's, when reading the request fails.
    pub(crate) fn is_pending_in(
        &self,
        store: &impl GrantStore,
        now: DateTime<Utc>,
    ) -> Result<bool, AuthorizationServerError> {
        let request = match self {
            Self::Device { user_code } => {
                store.pending_authorization_request_by_user_code(user_code)?
            }
            Self::OAuth { id } => store.authorization_request_by_id(id)?,
        };
        Ok(request.is_some_and(|request| {
            request.status == RequestStatus::Pending && request.expires_at > now
        }))
    }
}

#[cfg(test)]
mod tests {
    use chrono::Duration;

    use super::*;
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
                .insert_authorization_request(&code_request(id, status, expires_at))
                .unwrap();
        }
        store
            .insert_authorization_request(&device_request(
                "device-waiting",
                "ABCD-EFGH",
                RequestStatus::Pending,
            ))
            .unwrap();
        store
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
}
