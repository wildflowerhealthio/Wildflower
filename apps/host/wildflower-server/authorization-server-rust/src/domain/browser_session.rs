//! [`BrowserSession`] — a browser the server has signed in, keyed by the `sid`
//! every token, authorization code and refresh-token family minted under it
//! records. Revoking a session ends everything it minted: the token verifier
//! refuses a token whose `sid` names a revoked session, and refresh redemption
//! refuses a family whose `sid` does. [`RunStart`] — what the server's run
//! took over when it started, which decides whether an earlier run's
//! same-device session is still live.

use std::collections::HashSet;

use chrono::{DateTime, Duration, Utc};
use diesel::deserialize::FromSqlRow;
use diesel::expression::AsExpression;
use diesel::prelude::{Insertable, Queryable, Selectable};
use strum::{AsRefStr, Display, EnumString};

use crate::db::browser_sessions::browser_sessions;
use crate::db::shared::JsonStrings;
use crate::domain::same_device_sign_in_codes::SameDeviceSignInCode;

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
/// `kind` column, is the snake_case variant name: `same_device` or `paired`.
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
#[strum(serialize_all = "snake_case")]
#[serde(rename_all = "snake_case")]
#[diesel(sql_type = diesel::sql_types::Text)]
pub enum BrowserSessionKind {
    /// The Owner's browser, signed in on the server's own device with a
    /// same-device sign-in code.
    SameDevice,
    /// Any other browser: one that paired at `/oauth/pair`, showing a code the
    /// Owner approved.
    Paired,
}

/// One browser session. A session's scopes cap what any app requested in it
/// can receive: the Owner may approve an app for more, but the code issued
/// under the session carries only what the session also holds. Diesel-mapped
/// 1:1 to the `browser_sessions` table.
#[derive(Debug, Clone, PartialEq, Eq, Queryable, Selectable, Insertable)]
#[diesel(table_name = browser_sessions)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct BrowserSession {
    /// Primary key — the session's identity, and the `sid` claim of every
    /// authorization code, access token and refresh-token family minted under
    /// it.
    pub sid: String,
    /// How the browser came to hold the session: the Owner's same-device
    /// sign-in, or a pairing the Owner approved.
    pub kind: BrowserSessionKind,
    /// The name the browser was given at pairing; `None` for a same-device session.
    pub name: Option<String>,
    /// The session's grant: the most an app requested in this browser can be
    /// issued.
    #[diesel(serialize_as = JsonStrings, deserialize_as = JsonStrings)]
    pub scopes: Vec<String>,
    /// When the session started: the same-device sign-in, or the pairing
    /// poll that claimed the Owner's approval.
    pub created_at: DateTime<Utc>,
    /// When the session stops letting the browser start things.
    pub expires_at: DateTime<Utc>,
    /// When the session was revoked, ending everything it minted; `None`
    /// while it stands.
    pub revoked_at: Option<DateTime<Utc>>,
    /// When the session was last seen in use: its sign-in, then the server
    /// accepting its cookie (at most once every `LAST_SEEN_RESOLUTION`)
    /// and a refresh-token family that names it rotating.
    pub last_seen_at: DateTime<Utc>,
}

impl BrowserSession {
    /// A fresh same-device session with a new `sid`, holding `owner_scopes`
    /// and lasting `ttl` from `now`.
    #[must_use]
    pub fn new_same_device_session(
        owner_scopes: Vec<String>,
        ttl: Duration,
        now: DateTime<Utc>,
    ) -> Self {
        BrowserSession {
            sid: uuid::Uuid::new_v4().to_string(),
            kind: BrowserSessionKind::SameDevice,
            name: None,
            scopes: owner_scopes,
            created_at: now,
            expires_at: now + ttl,
            revoked_at: None,
            last_seen_at: now,
        }
    }

    /// A fresh paired session with a new `sid`, named `browser_name`,
    /// holding the `approved_scopes` the Owner granted and lasting `ttl` from
    /// `now`.
    #[must_use]
    pub fn new_paired_session(
        browser_name: String,
        approved_scopes: Vec<String>,
        ttl: Duration,
        now: DateTime<Utc>,
    ) -> Self {
        BrowserSession {
            sid: uuid::Uuid::new_v4().to_string(),
            kind: BrowserSessionKind::Paired,
            name: Some(browser_name),
            scopes: approved_scopes,
            created_at: now,
            expires_at: now + ttl,
            revoked_at: None,
            last_seen_at: now,
        }
    }

    /// Whether the session is live at `now`, in the run that `run_start`
    /// started: not revoked, `expires_at` after `now`, and, for a same-device
    /// session, one the run started or carried over. Every check of a
    /// session's liveness goes through here, so none skips the run's start.
    ///
    /// An app's request is approved into a code only while the session it
    /// was made in is live. Otherwise it is denied, so the app hears
    /// `access_denied` rather than earning a code no live session bounds.
    #[must_use]
    pub(crate) fn is_live_at(&self, now: DateTime<Utc>, run_start: &RunStart) -> bool {
        let belongs_to_the_run = self.kind != BrowserSessionKind::SameDevice
            || self.created_at >= run_start.started_at
            || run_start.carried_over_sids.contains(&self.sid);
        self.revoked_at.is_none() && self.expires_at > now && belongs_to_the_run
    }
}

/// What the server's run took over when it started: when that was, and the
/// same-device sessions it carried over from earlier runs, those the sign-in
/// codes of the host's launch views still open signed in. The host ends a
/// same-device session once the last of the server's launch views has
/// closed, so a session no open view holds is one whose ending was missed, as
/// across the app's exit, or failed. The run takes over no such session: one
/// an earlier run started and this one didn't carry over isn't live
/// ([`BrowserSession::is_live_at`]), though its row is left as it was. The
/// token verifier refuses its cookie, as it does an expired session's, and
/// the browser is sent through sign-in again, which the host's next launch
/// does. Paired sessions aren't a launch's, and every run takes them over.
#[derive(Debug)]
pub(crate) struct RunStart {
    /// When the run started: a session started since is the run's own.
    started_at: DateTime<Utc>,
    /// The `sid`s of the earlier runs' same-device sessions the run carried
    /// over: those the launch views still open hold.
    carried_over_sids: HashSet<String>,
}

impl RunStart {
    /// A run that started at `started_at`, carrying over the sessions
    /// `open_views_sign_in_codes`, the codes of the host's launch views still
    /// open, whichever run minted them, signed browsers in with.
    pub(crate) fn new(
        open_views_sign_in_codes: &[SameDeviceSignInCode],
        started_at: DateTime<Utc>,
    ) -> Self {
        RunStart {
            started_at,
            carried_over_sids: open_views_sign_in_codes
                .iter()
                .filter_map(SameDeviceSignInCode::signed_in_sid)
                .collect(),
        }
    }

    /// A run that started before any session did, so every session is its
    /// own.
    #[cfg(test)]
    pub(crate) fn before_any_session() -> Self {
        RunStart {
            started_at: DateTime::<Utc>::MIN_UTC,
            carried_over_sids: HashSet::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::domain::capabilities::oauth::{PAIRED_SESSION_TTL, SAME_DEVICE_SESSION_TTL};
    use crate::domain::same_device_sign_in_codes::SameDeviceSignInCodes;

    /// A same-device session is unnamed, lasts exactly its lifetime, starts
    /// unrevoked and seen at sign-in, and never shares a `sid` with another.
    #[test]
    fn a_same_device_session_is_unnamed_and_lasts_its_ttl() {
        let now = Utc::now();
        let session = BrowserSession::new_same_device_session(
            vec!["system/*.cruds".to_owned()],
            Duration::hours(8),
            now,
        );
        assert_eq!(session.kind, BrowserSessionKind::SameDevice);
        assert_eq!(session.name, None);
        assert_eq!(session.expires_at - session.created_at, Duration::hours(8));
        assert_eq!(session.revoked_at, None);
        assert_eq!(session.last_seen_at, now, "signing in is a use");
        assert_ne!(
            session.sid,
            BrowserSession::new_same_device_session(vec![], Duration::hours(8), now).sid,
            "every session gets its own sid"
        );
    }

    /// A paired session carries the browser's name and the approved scopes,
    /// lasts exactly its lifetime, and starts unrevoked.
    #[test]
    fn a_paired_session_is_named_and_lasts_its_ttl() {
        let now = Utc::now();
        let session = BrowserSession::new_paired_session(
            "Firefox on Linux".to_owned(),
            vec!["wildflower/launch".to_owned()],
            Duration::hours(24),
            now,
        );
        assert_eq!(session.kind, BrowserSessionKind::Paired);
        assert_eq!(session.name.as_deref(), Some("Firefox on Linux"));
        assert_eq!(session.scopes, ["wildflower/launch"]);
        assert_eq!(session.expires_at - session.created_at, Duration::hours(24));
        assert_eq!(session.revoked_at, None);
    }

    /// The kind's stored and wire string is its snake_case name.
    #[test]
    fn the_kind_is_stored_and_sent_as_its_snake_case_name() {
        assert_eq!(BrowserSessionKind::SameDevice.as_ref(), "same_device");
        assert_eq!(BrowserSessionKind::Paired.as_ref(), "paired");
        assert_eq!(
            "same_device".parse::<BrowserSessionKind>().ok(),
            Some(BrowserSessionKind::SameDevice)
        );
        assert_eq!(
            serde_json::to_value(BrowserSessionKind::SameDevice).ok(),
            Some(serde_json::json!("same_device"))
        );
    }

    /// A session is live until it expires or is revoked, whichever comes
    /// first.
    #[test]
    fn a_session_is_live_until_it_expires_or_is_revoked() {
        let now = Utc::now();
        let run_start = RunStart::before_any_session();
        let session = BrowserSession::new_same_device_session(vec![], Duration::hours(8), now);
        assert!(session.is_live_at(now, &run_start));
        assert!(!session.is_live_at(session.expires_at, &run_start));
        let revoked = BrowserSession {
            revoked_at: Some(now),
            ..session
        };
        assert!(!revoked.is_live_at(now, &run_start));
    }

    /// A same-device session an earlier run started is live only when the
    /// run carried it over; one started since, and a paired one, are live
    /// whatever the run carried over.
    #[test]
    fn a_run_carries_over_only_the_open_views_same_device_sessions() {
        let codes = Arc::new(SameDeviceSignInCodes::new());
        let started_at = Utc::now();
        let earlier = started_at - Duration::hours(1);
        let not_carried_over =
            BrowserSession::new_same_device_session(vec![], Duration::hours(8), earlier);
        let carried_over =
            BrowserSession::new_same_device_session(vec![], Duration::hours(8), earlier);
        let paired = BrowserSession::new_paired_session(
            "Firefox on Linux".to_owned(),
            vec![],
            Duration::hours(24),
            earlier,
        );
        let since = BrowserSession::new_same_device_session(vec![], Duration::hours(8), started_at);
        codes.insert("open-view-code", earlier);
        assert!(codes.take("open-view-code", earlier));
        assert!(codes.session_stored("open-view-code", &carried_over));
        let open_view_code =
            SameDeviceSignInCode::new("open-view-code".to_owned(), Arc::clone(&codes));

        let run_start = RunStart::new(&[open_view_code], started_at);

        assert!(!not_carried_over.is_live_at(started_at, &run_start));
        assert!(carried_over.is_live_at(started_at, &run_start));
        assert!(paired.is_live_at(started_at, &run_start));
        assert!(since.is_live_at(started_at, &run_start));
    }

    /// Each session is no longer than the longest session, which the
    /// revoked-`jti` purge floor and session retention rely on.
    #[test]
    fn every_session_is_within_the_longest_session() {
        assert!(SAME_DEVICE_SESSION_TTL <= LONGEST_BROWSER_SESSION_TTL);
        assert!(PAIRED_SESSION_TTL <= LONGEST_BROWSER_SESSION_TTL);
    }
}
