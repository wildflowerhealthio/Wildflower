//! [`SameDeviceSessionEnder`] — ends the Owner's same-device sessions, for
//! the host: those the sign-in codes of a server's launch views signed in,
//! once the server's last launch view closes. Ending a session expires it
//! rather than revoking it: its cookie stops working at once, and a
//! refresh-token family minted under it lives on as its client's refresh
//! policy says. [`EndedAtRunStart`] — the same-device sessions a run's start
//! ends: every one an earlier run signed in, but those of the launch views
//! still open. They are ended as they are next used, not at the start.

use std::collections::HashSet;

use chrono::{DateTime, Utc};

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::browser_session::{BrowserSession, BrowserSessionKind};
use crate::domain::grant_store::BrowserSessionsTx as _;
use crate::domain::same_device_sign_in_codes::SameDeviceSignInCode;
use crate::domain::GrantStore;

/// End same-device sessions. Generic over the store port so it's
/// unit-testable against the fake; the
/// [`SameDeviceSignInCodeMinter`](crate::SameDeviceSignInCodeMinter) binding
/// instantiates it over the concrete `SqliteGrantStore`.
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
}

/// The same-device sessions a run's start ends: every one started before the
/// run did, but those the launch views still open hold. The host ends a
/// session once the last of the server's launch views has closed, so a
/// session no open view holds is one whose ending was missed, as across the
/// app's exit, or failed, and one the host would otherwise never end. They
/// are ended as they are next used: the token verifier
/// refuses an ended one's cookie, as it does an expired one's, and the
/// browser is sent through sign-in again, which the host's next launch does.
/// The Browsers list leaves them out. Paired sessions stand.
#[derive(Debug)]
pub(crate) struct EndedAtRunStart {
    /// When the run started: a session started since is the run's own.
    run_started_at: DateTime<Utc>,
    /// The `sid`s of the sessions the launch views still open hold.
    kept_sids: HashSet<String>,
}

impl EndedAtRunStart {
    /// The same-device sessions the start, at `run_started_at`, of a run
    /// ends: every one but those `kept_sign_in_codes`, the codes of the
    /// host's launch views still open, whichever run minted them, signed
    /// browsers in with.
    pub(crate) fn new(
        kept_sign_in_codes: &[SameDeviceSignInCode],
        run_started_at: DateTime<Utc>,
    ) -> Self {
        EndedAtRunStart {
            run_started_at,
            kept_sids: kept_sign_in_codes
                .iter()
                .filter_map(SameDeviceSignInCode::signed_in_sid)
                .collect(),
        }
    }

    /// None: as a run's start before any session was.
    #[cfg(test)]
    pub(crate) fn none() -> Self {
        EndedAtRunStart {
            run_started_at: DateTime::<Utc>::MIN_UTC,
            kept_sids: HashSet::new(),
        }
    }

    /// Whether `session` is one the run's start ended.
    pub(crate) fn includes(&self, session: &BrowserSession) -> bool {
        session.kind == BrowserSessionKind::SameDevice
            && session.created_at < self.run_started_at
            && !self.kept_sids.contains(&session.sid)
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

    /// A run's start ends each same-device session started before it, but
    /// the kept codes' and paired ones, and none started since.
    #[test]
    fn a_run_start_ends_earlier_same_device_sessions_but_the_kept_and_paired() {
        let codes = Arc::new(SameDeviceSignInCodes::new());
        let run_started_at = Utc::now();
        let earlier = run_started_at - Duration::hours(1);
        let same_device =
            BrowserSession::new_same_device_session(vec![], Duration::hours(8), earlier);
        let kept = BrowserSession::new_same_device_session(vec![], Duration::hours(8), earlier);
        let paired = BrowserSession::new_paired_session(
            "Firefox on Linux".to_owned(),
            vec![],
            Duration::hours(24),
            earlier,
        );
        let since =
            BrowserSession::new_same_device_session(vec![], Duration::hours(8), run_started_at);
        let kept_code = signed_in_code(&codes, "open-view-code", &kept, earlier);

        let ended = EndedAtRunStart::new(&[kept_code], run_started_at);

        assert!(ended.includes(&same_device));
        assert!(!ended.includes(&kept));
        assert!(!ended.includes(&paired));
        assert!(!ended.includes(&since));
    }
}
