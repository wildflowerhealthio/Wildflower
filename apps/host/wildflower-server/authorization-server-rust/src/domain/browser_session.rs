//! [`BrowserSession`] — a browser the server has signed in, keyed by the `sid`
//! every token, authorization code and refresh-token family minted under it
//! records. Revoking a session ends everything it minted: the token verifier
//! refuses a token whose `sid` names a revoked session, and refresh redemption
//! refuses a family whose `sid` does.

use chrono::{DateTime, Duration, Utc};
use diesel::deserialize::FromSqlRow;
use diesel::expression::AsExpression;
use diesel::prelude::{Insertable, Queryable, Selectable};
use strum::{AsRefStr, Display, EnumString};

use crate::db::browser_sessions::browser_sessions;
use crate::db::shared::JsonStrings;

/// The longest a browser session may last: a day. No token the server mints
/// lives longer than a session may, so this is also the floor below which a
/// revoked `jti` may not be purged, and how long an ended session is kept for
/// the tokens that may still name it.
pub(crate) const LONGEST_BROWSER_SESSION_TTL: Duration = Duration::hours(24);

/// How finely a session's cookie use moves its `last_seen_at`: at most once
/// every five minutes, so a page load, which sends many requests, writes at
/// most once.
pub(crate) const LAST_SEEN_RESOLUTION: Duration = Duration::minutes(5);

/// How a browser came to hold its session. The wire string, stored in the
/// `kind` column, is the lowercased variant name.
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    EnumString,
    AsRefStr,
    Display,
    AsExpression,
    FromSqlRow,
    serde::Serialize,
)]
#[strum(serialize_all = "lowercase")]
#[serde(rename_all = "lowercase")]
#[diesel(sql_type = diesel::sql_types::Text)]
pub enum BrowserSessionKind {
    /// The Owner's browser, signed in on the server's own device with a
    /// same-device sign-in code.
    Owner,
    /// Any other browser: one that paired at `/oauth/pair`, showing a code the
    /// Owner approved.
    Approved,
}

/// One browser session. Diesel-mapped 1:1 to the `browser_sessions` table.
#[derive(Debug, Clone, PartialEq, Eq, Queryable, Selectable, Insertable)]
#[diesel(table_name = browser_sessions)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct BrowserSession {
    /// Primary key — the session id, the `sid` claim of every token minted
    /// under the session.
    pub sid: String,
    /// How the browser came to hold the session.
    pub kind: BrowserSessionKind,
    /// The name the browser was given at pairing; `None` for an Owner session.
    pub name: Option<String>,
    /// The session's grant.
    #[diesel(serialize_as = JsonStrings, deserialize_as = JsonStrings)]
    pub scopes: Vec<String>,
    /// When the browser signed in.
    pub created_at: DateTime<Utc>,
    /// When the session stops letting the browser start things.
    pub expires_at: DateTime<Utc>,
    /// When the session was revoked, ending everything it minted; `None`
    /// while it stands.
    pub revoked_at: Option<DateTime<Utc>>,
    /// When the session was last seen in use: its sign-in, then the server
    /// accepting its cookie (at most once every [`LAST_SEEN_RESOLUTION`])
    /// and a refresh-token family that names it rotating.
    pub last_seen_at: DateTime<Utc>,
}

impl BrowserSession {
    /// A fresh Owner session with a new `sid`, holding `owner_scopes`
    /// and lasting `ttl` from `now`.
    #[must_use]
    pub fn new_owner(owner_scopes: Vec<String>, ttl: Duration, now: DateTime<Utc>) -> Self {
        BrowserSession {
            sid: uuid::Uuid::new_v4().to_string(),
            kind: BrowserSessionKind::Owner,
            name: None,
            scopes: owner_scopes,
            created_at: now,
            expires_at: now + ttl,
            revoked_at: None,
            last_seen_at: now,
        }
    }

    /// A fresh approved session with a new `sid`, named `browser_name`,
    /// holding the `approved_scopes` the Owner granted and lasting `ttl` from
    /// `now`.
    #[must_use]
    pub fn new_approved(
        browser_name: String,
        approved_scopes: Vec<String>,
        ttl: Duration,
        now: DateTime<Utc>,
    ) -> Self {
        BrowserSession {
            sid: uuid::Uuid::new_v4().to_string(),
            kind: BrowserSessionKind::Approved,
            name: Some(browser_name),
            scopes: approved_scopes,
            created_at: now,
            expires_at: now + ttl,
            revoked_at: None,
            last_seen_at: now,
        }
    }

    /// Whether the session is live at `now`: not revoked, and `expires_at`
    /// after `now`.
    #[must_use]
    pub fn is_live(&self, now: DateTime<Utc>) -> bool {
        self.revoked_at.is_none() && self.expires_at > now
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::capabilities::oauth::{APPROVED_SESSION_TTL, OWNER_SESSION_TTL};

    #[test]
    fn an_owner_session_is_unnamed_and_lasts_its_ttl() {
        let now = Utc::now();
        let session =
            BrowserSession::new_owner(vec!["system/*.cruds".to_owned()], Duration::hours(8), now);
        assert_eq!(session.kind, BrowserSessionKind::Owner);
        assert_eq!(session.name, None);
        assert_eq!(session.expires_at - session.created_at, Duration::hours(8));
        assert_eq!(session.revoked_at, None);
        assert_eq!(session.last_seen_at, now, "signing in is a use");
        assert_ne!(
            session.sid,
            BrowserSession::new_owner(vec![], Duration::hours(8), now).sid,
            "every session gets its own sid"
        );
    }

    #[test]
    fn an_approved_session_is_named_and_lasts_its_ttl() {
        let now = Utc::now();
        let session = BrowserSession::new_approved(
            "Firefox on Linux".to_owned(),
            vec!["wildflower/launch".to_owned()],
            Duration::hours(24),
            now,
        );
        assert_eq!(session.kind, BrowserSessionKind::Approved);
        assert_eq!(session.name.as_deref(), Some("Firefox on Linux"));
        assert_eq!(session.scopes, ["wildflower/launch"]);
        assert_eq!(session.expires_at - session.created_at, Duration::hours(24));
        assert_eq!(session.revoked_at, None);
    }

    /// A session is live until it expires or is revoked, whichever comes
    /// first.
    #[test]
    fn a_session_is_live_until_it_expires_or_is_revoked() {
        let now = Utc::now();
        let session = BrowserSession::new_owner(vec![], Duration::hours(8), now);
        assert!(session.is_live(now));
        assert!(!session.is_live(session.expires_at));
        let revoked = BrowserSession {
            revoked_at: Some(now),
            ..session
        };
        assert!(!revoked.is_live(now));
    }

    /// Each session is no longer than the longest session, which the
    /// revoked-`jti` purge floor and session retention rely on.
    #[test]
    fn every_session_is_within_the_longest_session() {
        assert!(OWNER_SESSION_TTL <= LONGEST_BROWSER_SESSION_TTL);
        assert!(APPROVED_SESSION_TTL <= LONGEST_BROWSER_SESSION_TTL);
    }
}
