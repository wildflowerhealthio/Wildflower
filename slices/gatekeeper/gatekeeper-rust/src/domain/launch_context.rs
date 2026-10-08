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
#[derive(Debug, Clone, PartialEq, Eq, Queryable, Selectable, Insertable)]
#[diesel(table_name = launch_contexts)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct LaunchContext {
    /// Primary key — the opaque `launch` value the app is handed and echoes
    /// back at `/oauth/authorize`.
    pub nonce: String,
    /// The OAuth client the launch is for. An authorize from any other client
    /// can't consume it.
    pub client_id: String,
    /// The patient the launch binds, if any. When set, the consent approval
    /// must name the same patient.
    pub patient: Option<String>,
    /// When the launch was minted.
    pub created_at: DateTime<Utc>,
    /// Instant after which the launch can no longer be consumed.
    pub expires_at: DateTime<Utc>,
    /// When `/oauth/authorize` consumed the launch; `None` while unused.
    pub consumed_at: Option<DateTime<Utc>>,
}

impl LaunchContext {
    /// A fresh, unconsumed launch `nonce` for `client_id`, binding no patient,
    /// expiring [`LAUNCH_CONTEXT_TTL`] after `now`.
    #[must_use]
    pub fn new(nonce: String, client_id: &str, now: DateTime<Utc>) -> Self {
        LaunchContext {
            nonce,
            client_id: client_id.to_owned(),
            patient: None,
            created_at: now,
            expires_at: now + LAUNCH_CONTEXT_TTL,
            consumed_at: None,
        }
    }
}
