//! Browser-session capabilities — the `wildflower/BrowserSession.*`
//! capabilities behind `/authorization/browser-sessions[/{sid}]`: list the
//! browsers the server has signed in, and revoke one. Revoking a session ends
//! everything minted under it: the token verifier refuses a token whose `sid`
//! names a revoked session, and refresh redemption refuses a family whose
//! `sid` does. Generic over the store port, so each is unit-testable against
//! the in-memory fake.

use chrono::{DateTime, Utc};

use wildflowerhealthio_scopes::{Permission, Scope, WildflowerResource};

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::browser_session::BrowserSession;
use crate::domain::grant_store::BrowserSessionsTx as _;
use crate::domain::GrantStore;

/// The scope gating [`BrowserSessionsReader`] — `wildflower/BrowserSession.r`.
pub(crate) fn browser_sessions_reader_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::BrowserSession,
        Permission::READ,
    )]
}

/// The scope gating [`BrowserSessionsRevoker`] — `wildflower/BrowserSession.d`.
pub(crate) fn browser_sessions_revoker_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::BrowserSession,
        Permission::DELETE,
    )]
}

/// One live browser session, as the Owner's list shows it.
pub(crate) struct BrowserSessionView {
    pub(crate) session: BrowserSession,
    /// Whether the caller's own token was minted under the session (its
    /// `sid` names it).
    pub(crate) held_by_caller: bool,
}

/// Read access to the live browser sessions —
/// `GET /authorization/browser-sessions`.
pub(crate) struct BrowserSessionsReader<S: GrantStore> {
    store: S,
}

impl<S: GrantStore> BrowserSessionsReader<S> {
    /// Build the reader over a store handle lifted from the state.
    pub(crate) fn new(store: S) -> Self {
        BrowserSessionsReader { store }
    }

    /// Every browser session live at `now`, newest first, each marked by
    /// whether it is `caller_sid`'s, the session the caller's token was
    /// minted under.
    pub(crate) fn list_live(
        &self,
        caller_sid: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<Vec<BrowserSessionView>, AuthorizationServerError> {
        Ok(self
            .store
            .read(|tx| tx.live_browser_sessions(now))?
            .into_iter()
            .map(|session| BrowserSessionView {
                held_by_caller: caller_sid == Some(session.sid.as_str()),
                session,
            })
            .collect())
    }
}

/// Revoke a browser session — `DELETE /authorization/browser-sessions/{sid}`.
/// Distinct from [`BrowserSessionsReader`] because ending a session is a
/// `BrowserSession.d` capability. Revoking the caller's own session is allowed:
/// it signs that browser out.
pub(crate) struct BrowserSessionsRevoker<S: GrantStore> {
    store: S,
}

impl<S: GrantStore> BrowserSessionsRevoker<S> {
    /// Build the revoker over a store handle lifted from the state.
    pub(crate) fn new(store: S) -> Self {
        BrowserSessionsRevoker { store }
    }

    /// Revoke the session `sid` at `now`, ending everything minted under it.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::BrowserSessionNotFound`] when no unrevoked
    /// session row has the `sid` (none ever did, or it is already revoked; an
    /// expired session never revoked is still stamped);
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn revoke(
        &self,
        sid: &str,
        now: DateTime<Utc>,
    ) -> Result<(), AuthorizationServerError> {
        if self.store.write(|tx| tx.revoke_browser_session(sid, now))? {
            Ok(())
        } else {
            Err(AuthorizationServerError::BrowserSessionNotFound {
                sid: sid.to_owned(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::domain::grant_store::*;
    use chrono::Duration;

    use super::*;
    use crate::domain::test_fake::FakeGrantStore;

    /// The list holds only the live sessions, and marks the caller's.
    #[test]
    fn the_list_holds_the_live_sessions_and_marks_the_caller_s() {
        let store = FakeGrantStore::default();
        let now = Utc::now();
        let caller_s = BrowserSession::new_owner(vec![], Duration::hours(8), now);
        let other = BrowserSession::new_owner(vec![], Duration::hours(8), now - Duration::hours(1));
        let expired =
            BrowserSession::new_owner(vec![], Duration::hours(8), now - Duration::hours(9));
        let revoked = BrowserSession::new_owner(vec![], Duration::hours(8), now);
        for session in [&caller_s, &other, &expired, &revoked] {
            store.tx().insert_browser_session(session).unwrap();
        }
        store
            .tx()
            .revoke_browser_session(&revoked.sid, now)
            .unwrap();
        let reader = BrowserSessionsReader::new(store);

        let listed: Vec<(String, bool)> = reader
            .list_live(Some(&caller_s.sid), now)
            .unwrap()
            .into_iter()
            .map(|view| (view.session.sid, view.held_by_caller))
            .collect();
        assert_eq!(
            listed,
            vec![(caller_s.sid.clone(), true), (other.sid.clone(), false)]
        );

        assert!(
            reader
                .list_live(None, now)
                .unwrap()
                .iter()
                .all(|view| !view.held_by_caller),
            "a caller under no session holds none"
        );
    }

    /// Revoking stamps a standing session revoked; revoking it again, or an
    /// unknown session, is `BrowserSessionNotFound`.
    #[test]
    fn revoke_ends_a_standing_session_and_misses_anything_else() {
        let store = FakeGrantStore::default();
        let now = Utc::now();
        let session = BrowserSession::new_owner(vec![], Duration::hours(8), now);
        store.tx().insert_browser_session(&session).unwrap();
        let revoker = BrowserSessionsRevoker::new(store);

        assert_eq!(revoker.revoke(&session.sid, now), Ok(()));
        assert!(revoker
            .store
            .tx()
            .is_browser_session_revoked(&session.sid)
            .unwrap());
        for sid in [session.sid.as_str(), "no-such-sid"] {
            assert_eq!(
                revoker.revoke(sid, now),
                Err(AuthorizationServerError::BrowserSessionNotFound {
                    sid: sid.to_owned()
                }),
                "{sid}"
            );
        }
    }
}
