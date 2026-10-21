//! [`SameDeviceSessionEnder`] — ends the Owner's same-device sessions, for
//! the host: the one a launch's sign-in code started, when the launch's view
//! closes, and every one, when the server starts. Ending a session expires
//! it rather than revoking it: its cookie stops working at once, and a
//! refresh-token family minted under it lives on as its client's refresh
//! policy says.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::browser_session::BrowserSessionKind;
use crate::domain::grant_store::BrowserSessionsTx as _;
use crate::domain::same_device_sign_in_codes::SameDeviceSignInCodes;
use crate::domain::GrantStore;

/// End same-device sessions. Generic over the store port so it's
/// unit-testable against the fake; the
/// [`SameDeviceSignInCode`](crate::SameDeviceSignInCode) binding and the
/// server's setup instantiate it over the concrete `SqliteGrantStore`.
#[derive(Clone)]
pub(crate) struct SameDeviceSessionEnder<S: GrantStore> {
    /// The store holding the sessions it expires.
    store: S,
    /// The sign-in codes, which remember the session each redeemed code
    /// started.
    codes: Arc<SameDeviceSignInCodes>,
}

impl<S: GrantStore> SameDeviceSessionEnder<S> {
    /// Build it over a store handle and the server's sign-in codes.
    pub(crate) fn new(store: S, codes: Arc<SameDeviceSignInCodes>) -> Self {
        SameDeviceSessionEnder { store, codes }
    }

    /// Expire, at `now`, the session `sign_in_code` signed a browser in
    /// with, returning `true` iff one was ended. A code that signed nobody in,
    /// or whose session was ended already, ends nothing.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn end_session_signed_in_with(
        &self,
        sign_in_code: &str,
        now: DateTime<Utc>,
    ) -> Result<bool, AuthorizationServerError> {
        let Some(sid) = self.codes.take_signed_in_sid(sign_in_code) else {
            return Ok(false);
        };
        self.store.write(|tx| tx.expire_browser_session(&sid, now))
    }

    /// Expire, at `now`, every same-device session, returning how many were
    /// ended. Paired sessions stand.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn end_every_session(
        &self,
        now: DateTime<Utc>,
    ) -> Result<usize, AuthorizationServerError> {
        self.store
            .write(|tx| tx.expire_browser_sessions_of_kind(BrowserSessionKind::SameDevice, now))
    }
}

#[cfg(test)]
mod tests {
    use chrono::Duration;

    use super::*;
    use crate::domain::browser_session::BrowserSession;
    use crate::domain::grant_store::BrowserSessionsTx;
    use crate::domain::test_fake::FakeGrantStore;

    /// A same-device session started at `now`, stored in `store`.
    fn stored_same_device_session(store: &FakeGrantStore, now: DateTime<Utc>) -> BrowserSession {
        let session = BrowserSession::new_same_device_session(vec![], Duration::hours(8), now);
        store.tx().insert_browser_session(&session).expect("insert");
        session
    }

    /// The session `sid` as `store` holds it.
    fn stored(store: &FakeGrantStore, sid: &str) -> BrowserSession {
        store
            .tx()
            .browser_session_by_sid(sid)
            .expect("read")
            .expect("stored")
    }

    /// Ending by a code expires exactly the session that code signed in, at
    /// `now`, without revoking it; another code's session stands, and the
    /// same code ends nothing a second time.
    #[test]
    fn a_code_ends_only_its_own_session() {
        let store = FakeGrantStore::default();
        let codes = Arc::new(SameDeviceSignInCodes::new());
        let signed_in_at = Utc::now();
        let closed = stored_same_device_session(&store, signed_in_at);
        let still_open = stored_same_device_session(&store, signed_in_at);
        codes.record_signed_in_session("closed-code", &closed);
        codes.record_signed_in_session("open-code", &still_open);
        let ender = SameDeviceSessionEnder::new(store.clone(), codes);
        let now = signed_in_at + Duration::minutes(10);

        assert!(ender
            .end_session_signed_in_with("closed-code", now)
            .expect("end"));
        assert!(!ender
            .end_session_signed_in_with("closed-code", now)
            .expect("end again"));

        assert_eq!(
            stored(&store, &closed.sid),
            BrowserSession {
                expires_at: now,
                ..closed
            },
            "expired, not revoked"
        );
        assert_eq!(stored(&store, &still_open.sid), still_open);
    }

    /// A code that signed nobody in ends nothing.
    #[test]
    fn a_code_that_signed_nobody_in_ends_nothing() {
        let store = FakeGrantStore::default();
        let now = Utc::now();
        let session = stored_same_device_session(&store, now);
        let ender =
            SameDeviceSessionEnder::new(store.clone(), Arc::new(SameDeviceSignInCodes::new()));
        assert!(!ender
            .end_session_signed_in_with("unredeemed-code", now)
            .expect("end"));
        assert_eq!(stored(&store, &session.sid), session);
    }

    /// Ending every session expires each live same-device session, and leaves
    /// paired sessions and an already-expired one as they were.
    #[test]
    fn ending_every_session_expires_the_same_device_ones_only() {
        let store = FakeGrantStore::default();
        let now = Utc::now();
        let same_device = stored_same_device_session(&store, now - Duration::hours(1));
        let already_expired = stored_same_device_session(&store, now - Duration::hours(9));
        let paired = BrowserSession::new_paired_session(
            "Firefox on Linux".to_owned(),
            vec![],
            Duration::hours(24),
            now - Duration::hours(1),
        );
        store.tx().insert_browser_session(&paired).expect("insert");
        let ender =
            SameDeviceSessionEnder::new(store.clone(), Arc::new(SameDeviceSignInCodes::new()));

        assert_eq!(ender.end_every_session(now).expect("end"), 1);

        assert_eq!(
            stored(&store, &same_device.sid),
            BrowserSession {
                expires_at: now,
                ..same_device
            }
        );
        assert_eq!(stored(&store, &already_expired.sid), already_expired);
        assert_eq!(stored(&store, &paired.sid), paired);
    }
}
