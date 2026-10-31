//! Browser-session capabilities — the `wildflower/BrowserSession.*`
//! capabilities behind `/authorization/browser-sessions[/{sid}]`: list the
//! browsers the server has signed in, and revoke one. Revoking a session ends
//! everything minted under it: the token verifier refuses a token whose `sid`
//! names a revoked session, and refresh redemption refuses a family whose
//! `sid` does, and denies the widenings it asked for that still wait for the
//! Owner. Generic over the store port, so each is unit-testable against the
//! in-memory fake.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use wildflowerhealthio_scopes::{Permission, Scope, WildflowerResource};

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::browser_session::{BrowserSession, StaleSessionCutoff};
use crate::domain::grant_store::{AuthorizationRequestsTx, BrowserSessionsTx};
use crate::domain::GrantStore;
use crate::ports::OwnerApproval;

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
    /// The live session the row shows.
    pub(crate) session: BrowserSession,
    /// Whether the caller's own token was minted under the session (its
    /// `sid` names it).
    pub(crate) held_by_caller: bool,
}

/// Read access to the live browser sessions —
/// `GET /authorization/browser-sessions`.
pub(crate) struct BrowserSessionsReader<S: GrantStore> {
    /// The store the sessions are read from.
    store: S,
    /// The cutoff before which a same-device session is stale, which the
    /// list leaves out.
    stale_session_cutoff: Arc<StaleSessionCutoff>,
}

impl<S: GrantStore> BrowserSessionsReader<S> {
    /// Build the reader over a store handle and the stale-session cutoff,
    /// lifted from the state.
    pub(crate) fn new(store: S, stale_session_cutoff: Arc<StaleSessionCutoff>) -> Self {
        BrowserSessionsReader {
            store,
            stale_session_cutoff,
        }
    }

    /// Every browser session
    /// [live](crate::domain::browser_session::BrowserSession::is_live_at) at
    /// `now`, newest first, each marked by whether it is
    /// `caller_sid`'s, the session the caller's token was minted under. A
    /// caller under no session holds none of them.
    pub(crate) fn list_live(
        &self,
        caller_sid: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<Vec<BrowserSessionView>, AuthorizationServerError> {
        Ok(self
            .store
            .read(|tx| tx.live_browser_sessions(now))?
            .into_iter()
            .filter(|session| session.is_live_at(now, &self.stale_session_cutoff))
            .map(|session| BrowserSessionView {
                held_by_caller: caller_sid == Some(session.sid.as_str()),
                session,
            })
            .collect())
    }
}

/// What [`revoke_browser_session`] did.
pub(crate) struct RevokedBrowserSession {
    /// An unrevoked session row had the `sid`, and is revoked now.
    pub(crate) revoked: bool,
    /// A widening of the session that still waited for the Owner was denied,
    /// so the Owner prompt has changed.
    pub(crate) widenings_denied: bool,
}

/// Revoke the browser session `sid` at `now` in the caller's write scope, and
/// deny every widening of it still waiting for the Owner: a revoked browser
/// can never collect one, so the Owner isn't asked about it.
///
/// # Errors
///
/// [`AuthorizationServerError::Infrastructure`] on a store failure.
pub(crate) fn revoke_browser_session(
    tx: &mut (impl BrowserSessionsTx + AuthorizationRequestsTx),
    sid: &str,
    now: DateTime<Utc>,
) -> Result<RevokedBrowserSession, AuthorizationServerError> {
    let revoked = tx.revoke_browser_session(sid, now)?;
    let mut widenings_denied = false;
    for widening_request in tx.pending_session_widening_requests_for_session(sid, now)? {
        if let Ok(denied) = widening_request.deny(now) {
            widenings_denied |= tx.replace_session_widening_request(&widening_request, &denied)?;
        }
    }
    Ok(RevokedBrowserSession {
        revoked,
        widenings_denied,
    })
}

/// Revoke a browser session — `DELETE /authorization/browser-sessions/{sid}`.
/// Distinct from [`BrowserSessionsReader`] because ending a session is a
/// `BrowserSession.d` capability. Revoking the caller's own session is allowed:
/// it signs that browser out.
pub(crate) struct BrowserSessionsRevoker<S: GrantStore> {
    /// The store the revocation is written to.
    store: S,
    /// Republishes the Owner prompt once a revocation has denied a widening
    /// the Owner was being asked about.
    owner_approval: Arc<dyn OwnerApproval>,
}

impl<S: GrantStore> BrowserSessionsRevoker<S> {
    /// Build the revoker over a store handle and the republish port, lifted
    /// from the state.
    pub(crate) fn new(store: S, owner_approval: Arc<dyn OwnerApproval>) -> Self {
        BrowserSessionsRevoker {
            store,
            owner_approval,
        }
    }

    /// Revoke the session `sid` at `now`, ending everything minted under it,
    /// and deny its widenings still waiting for the Owner
    /// ([`revoke_browser_session`]), republishing the Owner prompt when it
    /// denied one.
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
        let revoked_session = self
            .store
            .write(|tx| revoke_browser_session(tx, sid, now))?;
        if revoked_session.widenings_denied {
            self.owner_approval.republish_active();
        }
        if revoked_session.revoked {
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
    use std::collections::HashSet;

    use super::*;
    use crate::domain::authorization_request::session_widening::{
        NewSessionWideningRequestArgs, SessionWideningRequest,
    };
    use crate::domain::authorization_request::RequestStatus;
    use crate::domain::test_fake::{FakeGrantStore, RecordingOwnerApproval};

    /// The list holds only the live sessions, not a stale same-device
    /// session, and marks the caller's.
    #[test]
    fn the_list_holds_the_live_sessions_and_marks_the_caller_s() {
        let store = FakeGrantStore::default();
        let now = Utc::now();
        let caller_s = BrowserSession::new_same_device_session(vec![], Duration::hours(8), now);
        let other = BrowserSession::new_same_device_session(
            vec![],
            Duration::hours(8),
            now - Duration::minutes(10),
        );
        let stale = BrowserSession::new_same_device_session(
            vec![],
            Duration::hours(8),
            now - Duration::hours(1),
        );
        let expired = BrowserSession::new_same_device_session(
            vec![],
            Duration::hours(8),
            now - Duration::hours(9),
        );
        let revoked = BrowserSession::new_same_device_session(vec![], Duration::hours(8), now);
        for session in [&caller_s, &other, &stale, &expired, &revoked] {
            store.tx().insert_browser_session(session).unwrap();
        }
        store
            .tx()
            .revoke_browser_session(&revoked.sid, now)
            .unwrap();
        let reader = BrowserSessionsReader::new(
            store,
            Arc::new(StaleSessionCutoff::new(
                now - Duration::minutes(30),
                HashSet::new(),
            )),
        );

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
        let session = BrowserSession::new_same_device_session(vec![], Duration::hours(8), now);
        store.tx().insert_browser_session(&session).unwrap();
        let revoker =
            BrowserSessionsRevoker::new(store, Arc::new(RecordingOwnerApproval::default()));

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

    /// Revoking a paired session denies its widening still waiting for the
    /// Owner, and republishes the Owner prompt; another session's widening
    /// waits on.
    #[test]
    fn revoke_denies_the_session_s_pending_widenings() {
        let store = FakeGrantStore::default();
        let now = Utc::now();
        let widening_of = |id: &str, sid: &str| {
            SessionWideningRequest::new(
                NewSessionWideningRequestArgs {
                    id: id.to_owned(),
                    sid: sid.to_owned(),
                    client_id: "app".to_owned(),
                    browser_name: "Firefox on Linux".to_owned(),
                    requested_scopes: vec!["patient/Observation.r".to_owned()],
                    ttl: Duration::minutes(5),
                },
                now,
            )
        };
        let revoked = BrowserSession::new_paired_session(
            "Firefox on Linux".to_owned(),
            vec![],
            Duration::hours(24),
            now,
        );
        store.tx().insert_browser_session(&revoked).unwrap();
        store
            .tx()
            .insert_session_widening_request(&widening_of("widen-revoked", &revoked.sid))
            .unwrap();
        store
            .tx()
            .insert_session_widening_request(&widening_of("widen-other", "other-sid"))
            .unwrap();
        let owner_approval = Arc::new(RecordingOwnerApproval::default());
        let revoker = BrowserSessionsRevoker::new(store, owner_approval.clone());

        assert_eq!(revoker.revoke(&revoked.sid, now), Ok(()));
        let status_of = |id: &str| {
            revoker
                .store
                .tx()
                .session_widening_request_by_id(id)
                .unwrap()
                .expect("present")
                .state
                .status()
        };
        assert_eq!(status_of("widen-revoked"), RequestStatus::Denied);
        assert_eq!(status_of("widen-other"), RequestStatus::Pending);
        assert_eq!(owner_approval.count(), 1);

        let fresh = BrowserSession::new_paired_session(
            "Safari on iOS".to_owned(),
            vec![],
            Duration::hours(24),
            now,
        );
        revoker.store.tx().insert_browser_session(&fresh).unwrap();
        assert_eq!(revoker.revoke(&fresh.sid, now), Ok(()));
        assert_eq!(
            owner_approval.count(),
            1,
            "nothing denied, nothing republished"
        );
    }
}
