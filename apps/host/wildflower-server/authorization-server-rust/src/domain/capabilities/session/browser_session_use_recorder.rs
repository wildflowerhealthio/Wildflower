//! [`BrowserSessionUseRecorder`] — moves a browser session's `last_seen_at`
//! when the server accepts its cookie, at most once every
//! [`LAST_SEEN_RESOLUTION`] per session: a [`LastSeenThrottle`] lets one use
//! per window on to a conditional update, so most requests write nothing. An
//! update that fails lifts the throttle's note, so the next use tries again.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use crate::domain::access_token::VerifiedClaims;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::browser_session::LAST_SEEN_RESOLUTION;
use crate::domain::grant_store::BrowserSessionsTx as _;
use crate::domain::last_seen_throttle::LastSeenThrottle;
use crate::domain::GrantStore;

/// Record a browser session's cookie use. Holds the store and the throttle
/// lifted from the state.
pub(crate) struct BrowserSessionUseRecorder<S: GrantStore> {
    /// The store holding the session's `last_seen_at`, whose update is itself
    /// conditional on the window, so the window holds even when the throttle
    /// is empty after a restart.
    store: S,
    /// The state's one in-memory throttle, shared by every request, letting
    /// one use per session per window through to the store.
    throttle: Arc<LastSeenThrottle>,
}

impl<S: GrantStore> BrowserSessionUseRecorder<S> {
    /// Build the recorder over the handles lifted from the state.
    pub(crate) fn new(store: S, throttle: Arc<LastSeenThrottle>) -> Self {
        BrowserSessionUseRecorder { store, throttle }
    }

    /// Record that the cookie holding the browser session `session_claims`
    /// name (their `sid`) was accepted at `now`: its `last_seen_at` moves to
    /// `now` unless it moved within the last [`LAST_SEEN_RESOLUTION`]. Claims
    /// with no `sid` name no session and record nothing.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] when the update fails.
    pub(crate) fn record_cookie_use(
        &self,
        session_claims: &VerifiedClaims,
        now: DateTime<Utc>,
    ) -> Result<(), AuthorizationServerError> {
        let Some(sid) = session_claims.sid.as_deref() else {
            return Ok(());
        };
        if !self.throttle.admit(sid, now) {
            return Ok(());
        }
        self.store
            .write(|tx| tx.touch_browser_session_last_seen(sid, now, now - LAST_SEEN_RESOLUTION))
            .inspect_err(|_| self.throttle.forget(sid))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::domain::grant_store::*;
    use chrono::Duration;

    use super::*;
    use crate::domain::browser_session::BrowserSession;
    use crate::domain::test_fake::FakeGrantStore;

    /// Verified claims for the `browsers` subject under `sid`, or under no
    /// session.
    fn claims(sid: Option<&str>) -> VerifiedClaims {
        VerifiedClaims {
            issuer: "iss".to_owned(),
            subject: "browsers".to_owned(),
            jti: None,
            audience: vec![],
            expires_at: None,
            issued_at: None,
            scope: None,
            patient: None,
            sid: sid.map(str::to_owned),
        }
    }

    /// The stored `last_seen_at` of the session `sid`.
    fn last_seen(store: &FakeGrantStore, sid: &str) -> DateTime<Utc> {
        store
            .tx()
            .browser_session_by_sid(sid)
            .expect("read")
            .expect("stored")
            .last_seen_at
    }

    /// A use moves `last_seen_at`; another inside the window leaves it, and
    /// one after the window moves it again.
    #[test]
    fn a_cookie_use_moves_last_seen_at_most_once_a_window() {
        let signed_in_at = Utc::now() - Duration::hours(1);
        let session =
            BrowserSession::new_same_device_session(vec![], Duration::hours(8), signed_in_at);
        let store = FakeGrantStore::default();
        store.tx().insert_browser_session(&session).expect("insert");
        let recorder = BrowserSessionUseRecorder::new(store, Arc::new(LastSeenThrottle::new()));
        let session_claims = claims(Some(&session.sid));

        let first_use = Utc::now();
        recorder
            .record_cookie_use(&session_claims, first_use)
            .expect("recorded");
        assert_eq!(last_seen(&recorder.store, &session.sid), first_use);

        recorder
            .record_cookie_use(&session_claims, first_use + Duration::minutes(4))
            .expect("recorded");
        assert_eq!(last_seen(&recorder.store, &session.sid), first_use);

        let after_the_window = first_use + LAST_SEEN_RESOLUTION;
        recorder
            .record_cookie_use(&session_claims, after_the_window)
            .expect("recorded");
        assert_eq!(last_seen(&recorder.store, &session.sid), after_the_window);
    }

    /// An emptied throttle (a restart) lets a use through, but the update's
    /// own guard still keeps `last_seen_at` inside the window.
    #[test]
    fn the_update_guard_holds_the_window_across_a_restart() {
        let signed_in_at = Utc::now();
        let session =
            BrowserSession::new_same_device_session(vec![], Duration::hours(8), signed_in_at);
        let store = FakeGrantStore::default();
        store.tx().insert_browser_session(&session).expect("insert");
        let restarted = BrowserSessionUseRecorder::new(store, Arc::new(LastSeenThrottle::new()));
        restarted
            .record_cookie_use(
                &claims(Some(&session.sid)),
                signed_in_at + Duration::minutes(1),
            )
            .expect("recorded");
        assert_eq!(last_seen(&restarted.store, &session.sid), signed_in_at);
    }

    /// Claims with no `sid` record nothing.
    #[test]
    fn claims_without_a_session_record_nothing() {
        let recorder = BrowserSessionUseRecorder::new(
            FakeGrantStore::default(),
            Arc::new(LastSeenThrottle::new()),
        );
        recorder
            .record_cookie_use(&claims(None), Utc::now())
            .expect("nothing to record");
    }
}
