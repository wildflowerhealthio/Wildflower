use chrono::{DateTime, Duration, Utc};
use diesel::prelude::{Insertable, Queryable, Selectable};

use crate::db::launch_contexts::launch_contexts;

/// Lifetime of a [`LaunchContext`], from mint to the `/oauth/authorize` that
/// consumes it: five minutes, the same as a parked authorization request's.
pub const LAUNCH_CONTEXT_TTL: Duration = Duration::minutes(5);

/// One SMART App Launch `launch` value this server handed out, and what it
/// binds. Minted in-process (the apps launch route, the base's launch) through
/// the [`LaunchContexts`](crate::domain::capabilities::oauth::LaunchContexts)
/// capability, and consumed single-use by the `/oauth/authorize` request that
/// presents it. Diesel-mapped 1:1 to the `launch_contexts` table.
///
/// A launch is for one OAuth client ([`LaunchContext::for_client`]) or for any
/// client ([`LaunchContext::for_any_client`]). Only a launch for one client can
/// bind a patient: the client and patient fields are private so no other shape
/// can be built, and the table's CHECK holds the same rule.
#[derive(Debug, Clone, PartialEq, Eq, Queryable, Selectable, Insertable)]
#[diesel(table_name = launch_contexts)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct LaunchContext {
    /// Primary key — the opaque `launch` value the app is handed and echoes
    /// back at `/oauth/authorize`.
    pub nonce: String,
    /// The OAuth client the launch is for; `None` when any client may consume
    /// it. An authorize from any other client can't consume it.
    client_id: Option<String>,
    /// The patient the launch binds, if any. When set, the consent approval
    /// must name the same patient. Set only alongside `client_id`.
    patient: Option<String>,
    /// When the launch was minted.
    pub created_at: DateTime<Utc>,
    /// Instant after which the launch can no longer be consumed.
    pub expires_at: DateTime<Utc>,
    /// When `/oauth/authorize` consumed the launch; `None` while unused.
    pub consumed_at: Option<DateTime<Utc>>,
}

impl LaunchContext {
    /// A fresh, unconsumed launch `nonce` for `client_id`, binding `patient`
    /// when given, expiring [`LAUNCH_CONTEXT_TTL`] after `now`.
    #[must_use]
    pub fn for_client(
        nonce: String,
        client_id: &str,
        patient: Option<String>,
        now: DateTime<Utc>,
    ) -> Self {
        LaunchContext {
            nonce,
            client_id: Some(client_id.to_owned()),
            patient,
            created_at: now,
            expires_at: now + LAUNCH_CONTEXT_TTL,
            consumed_at: None,
        }
    }

    /// A fresh, unconsumed launch `nonce` that any client may consume, binding
    /// no patient, expiring [`LAUNCH_CONTEXT_TTL`] after `now`.
    #[must_use]
    pub fn for_any_client(nonce: String, now: DateTime<Utc>) -> Self {
        LaunchContext {
            nonce,
            client_id: None,
            patient: None,
            created_at: now,
            expires_at: now + LAUNCH_CONTEXT_TTL,
            consumed_at: None,
        }
    }

    /// The OAuth client the launch is for; `None` for a launch any client may
    /// consume.
    #[must_use]
    pub fn client_id(&self) -> Option<&str> {
        self.client_id.as_deref()
    }

    /// The patient the launch binds, if any.
    #[must_use]
    pub fn patient(&self) -> Option<&str> {
        self.patient.as_deref()
    }

    /// Whether `client_id` may consume the launch: it is for that client, or
    /// for any client.
    #[must_use]
    pub fn admits_client(&self, client_id: &str) -> bool {
        self.client_id
            .as_deref()
            .is_none_or(|launch_client_id| launch_client_id == client_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A launch for one client admits only that client; a launch for any
    /// client admits every client and binds no patient.
    #[test]
    fn a_launch_admits_its_client_or_any_client() {
        let now = Utc::now();
        let for_app = LaunchContext::for_client("n1".to_owned(), "app", None, now);
        assert!(for_app.admits_client("app"));
        assert!(!for_app.admits_client("other-app"));

        let for_any_client = LaunchContext::for_any_client("n2".to_owned(), now);
        assert_eq!(for_any_client.client_id(), None);
        assert_eq!(for_any_client.patient(), None);
        assert!(for_any_client.admits_client("app"));
        assert!(for_any_client.admits_client("other-app"));
    }
}
