//! [`SameDeviceSessionEnder`] — ends the Owner's same-device sessions, for
//! the host: those the sign-in codes of a server's launch views signed in,
//! once the server's last launch view closes, and, as the server starts,
//! every one but those of the launch views still open. Ending a session
//! expires it rather than revoking it: its cookie stops working at once, and
//! a refresh-token family minted under it lives on as its client's refresh
//! policy says.

use chrono::{DateTime, Utc};

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::browser_session::BrowserSessionKind;
use crate::domain::grant_store::BrowserSessionsTx as _;
use crate::domain::same_device_sign_in_codes::SameDeviceSignInCode;
use crate::domain::GrantStore;

/// End same-device sessions. Generic over the store port so it's
/// unit-testable against the fake; the
/// [`SameDeviceSignInCodeMinter`](crate::SameDeviceSignInCodeMinter) binding
/// and the server's setup instantiate it over the concrete `SqliteGrantStore`.
pub(crate) struct SameDeviceSessionEnder<S: GrantStore> {
    /// The store holding the sessions it expires.
    store: S,
}

impl<S: GrantStore> SameDeviceSessionEnder<S> {
    /// Build it over a store handle.
    pub(crate) fn new(store: S) -> Self {
        SameDeviceSessionEnder { store }
    }

    /// Withdraw each of `sign_in_codes`, and expire, at `now`, the sessions
    /// they signed browsers in with, returning how many were ended. A code
    /// that signed nobody in, or whose session was ended already, ends
    /// nothing. Each code forgets its session only once the write lands, so
    /// a failed write can be tried again with the same codes.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn end_sessions_signed_in_with(
        &self,
        sign_in_codes: &[SameDeviceSignInCode],
        now: DateTime<Utc>,
    ) -> Result<usize, AuthorizationServerError> {
        let sids: Vec<String> = sign_in_codes
            .iter()
            .filter_map(|sign_in_code| {
                sign_in_code.withdraw();
                sign_in_code.signed_in_sid()
            })
            .collect();
        let ended = self.store.write(|tx| {
            sids.iter().try_fold(0, |ended, sid| {
                Ok::<_, AuthorizationServerError>(
                    ended + usize::from(tx.expire_browser_session(sid, now)?),
                )
            })
        })?;
        for sign_in_code in sign_in_codes {
            sign_in_code.forget_session();
        }
        Ok(ended)
    }

    /// Expire, at `now`, every same-device session but those
    /// `kept_sign_in_codes` signed browsers in with, returning how many were
    /// ended. Paired sessions stand.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn end_every_session_but(
        &self,
        kept_sign_in_codes: &[SameDeviceSignInCode],
        now: DateTime<Utc>,
    ) -> Result<usize, AuthorizationServerError> {
        let kept_sids: Vec<String> = kept_sign_in_codes
            .iter()
            .filter_map(SameDeviceSignInCode::signed_in_sid)
            .collect();
        self.store.write(|tx| {
            tx.expire_browser_sessions_of_kind_but(BrowserSessionKind::SameDevice, &kept_sids, now)
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use chrono::Duration;

    use super::*;
    use crate::domain::browser_session::BrowserSession;
    use crate::domain::grant_store::BrowserSessionsTx;
    use crate::domain::same_device_sign_in_codes::SameDeviceSignInCodes;
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

    /// A code `code`, minted into `codes` at `now`, that signed a browser in
    /// with `session`.
    fn signed_in_code(
        codes: &Arc<SameDeviceSignInCodes>,
        code: &str,
        session: &BrowserSession,
        now: DateTime<Utc>,
    ) -> SameDeviceSignInCode {
        codes.insert(code, now);
        assert!(codes.take(code, now));
        assert!(codes.session_stored(code, session));
        SameDeviceSignInCode::new(code.to_owned(), Arc::clone(codes))
    }

    /// Ending by codes expires exactly the sessions those codes signed in, at
    /// `now`, without revoking them; another code's session stands, and the
    /// same codes end nothing a second time.
    #[test]
    fn codes_end_only_their_own_sessions() {
        let store = FakeGrantStore::default();
        let codes = Arc::new(SameDeviceSignInCodes::new());
        let signed_in_at = Utc::now();
        let closed = stored_same_device_session(&store, signed_in_at);
        let still_open = stored_same_device_session(&store, signed_in_at);
        let closed_code = signed_in_code(&codes, "closed-code", &closed, signed_in_at);
        signed_in_code(&codes, "open-code", &still_open, signed_in_at);
        let unredeemed_code = SameDeviceSignInCode::new("unredeemed-code".to_owned(), codes);
        let ender = SameDeviceSessionEnder::new(store.clone());
        let now = signed_in_at + Duration::minutes(10);
        let closed_codes = [closed_code, unredeemed_code];

        assert_eq!(
            ender
                .end_sessions_signed_in_with(&closed_codes, now)
                .expect("end"),
            1
        );
        assert_eq!(
            ender
                .end_sessions_signed_in_with(&closed_codes, now)
                .expect("end again"),
            0
        );

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

    /// Ending by codes withdraws an unredeemed one, so it signs nobody in.
    #[test]
    fn ending_by_an_unredeemed_code_withdraws_it() {
        let codes = Arc::new(SameDeviceSignInCodes::new());
        let now = Utc::now();
        codes.insert("code-1", now);
        let ender = SameDeviceSessionEnder::new(FakeGrantStore::default());
        assert_eq!(
            ender
                .end_sessions_signed_in_with(
                    &[SameDeviceSignInCode::new(
                        "code-1".to_owned(),
                        Arc::clone(&codes)
                    )],
                    now,
                )
                .expect("end"),
            0
        );
        assert!(!codes.take("code-1", now));
    }

    /// Ending every session but the kept codes' expires each other live
    /// same-device session, and leaves the kept one, paired sessions and an
    /// already-expired one as they were.
    #[test]
    fn ending_every_session_keeps_the_kept_codes_and_paired_ones() {
        let store = FakeGrantStore::default();
        let codes = Arc::new(SameDeviceSignInCodes::new());
        let now = Utc::now();
        let same_device = stored_same_device_session(&store, now - Duration::hours(1));
        let kept = stored_same_device_session(&store, now - Duration::hours(1));
        let already_expired = stored_same_device_session(&store, now - Duration::hours(9));
        let paired = BrowserSession::new_paired_session(
            "Firefox on Linux".to_owned(),
            vec![],
            Duration::hours(24),
            now - Duration::hours(1),
        );
        store.tx().insert_browser_session(&paired).expect("insert");
        let kept_code = signed_in_code(&codes, "open-view-code", &kept, now);
        let ender = SameDeviceSessionEnder::new(store.clone());

        assert_eq!(
            ender.end_every_session_but(&[kept_code], now).expect("end"),
            1
        );

        assert_eq!(
            stored(&store, &same_device.sid),
            BrowserSession {
                expires_at: now,
                ..same_device
            }
        );
        assert_eq!(stored(&store, &kept.sid), kept);
        assert_eq!(stored(&store, &already_expired.sid), already_expired);
        assert_eq!(stored(&store, &paired.sid), paired);
    }
}
