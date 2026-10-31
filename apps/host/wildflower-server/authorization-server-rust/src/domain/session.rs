//! Session-token operations: logout's revoke of the caller's own token, kept
//! out of the logout handler so the best-effort denylist decision is a pure,
//! testable domain operation over the [`Revocation`]
//! port (no real revocation store in the way).

use chrono::{DateTime, Utc};

use crate::ports::Revocation;

/// Denylist the logged-out session token's `jti` until `expires_at`, so a leaked
/// copy of the token can't be replayed after logout.
///
/// **Best-effort by design:** the `/authorization` gate already verified the request's
/// token, so this only recovers the trusted `jti` + `exp` to denylist; any store
/// hiccup (already revoked, transient failure) must never fail the logout — the
/// client has already forgotten the token — so a failure is logged and
/// swallowed rather than returned.
pub(crate) fn revoke_session_token(
    revoker: &(impl Revocation + ?Sized),
    jti: &str,
    expires_at: DateTime<Utc>,
) {
    if let Err(error) = revoker.revoke_jti(jti, expires_at, "logout") {
        tracing::warn!(%error, "logout: failed to revoke presented token jti");
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// A [`Revocation`] port that records each `jti` revoke, and fails every
    /// one when `fail` is set.
    #[derive(Default)]
    struct RecordingRevoker {
        /// Each `revoke_jti` call: the `jti`, its expiry and the reason.
        calls: Mutex<Vec<(String, DateTime<Utc>, String)>>,
        /// Whether every revoke answers a store failure.
        fail: bool,
    }

    impl Revocation for RecordingRevoker {
        fn revoke_jti(
            &self,
            jti: &str,
            expires_at: DateTime<Utc>,
            reason: &str,
        ) -> Result<(), String> {
            self.calls
                .lock()
                .unwrap()
                .push((jti.to_owned(), expires_at, reason.to_owned()));
            if self.fail {
                Err("store unavailable".to_owned())
            } else {
                Ok(())
            }
        }

        fn revoke_jti_from(
            &self,
            _jti: &str,
            _revoked_from: DateTime<Utc>,
            _expires_at: DateTime<Utc>,
            _reason: &str,
        ) -> Result<(), String> {
            unreachable!("logout revokes a jti at once")
        }

        fn revoke_subject_as_of_now(&self, _subject: &str) -> Result<(), String> {
            unreachable!("logout revokes a jti, never a subject")
        }
    }

    /// Logout denylists the token's `jti` until its expiry, with the reason
    /// `logout`.
    #[test]
    fn revokes_the_jti_with_the_logout_reason() {
        let revoker = RecordingRevoker::default();
        let exp = Utc::now();
        revoke_session_token(&revoker, "jti-1", exp);
        assert_eq!(
            *revoker.calls.lock().unwrap(),
            vec![("jti-1".to_owned(), exp, "logout".to_owned())],
        );
    }

    /// A revocation store failure is logged and swallowed, so the logout
    /// still goes ahead.
    #[test]
    fn swallows_a_store_failure_so_the_logout_still_proceeds() {
        let revoker = RecordingRevoker {
            fail: true,
            ..RecordingRevoker::default()
        };
        // Must not panic or propagate — the caller relies on this being infallible.
        revoke_session_token(&revoker, "jti-1", Utc::now());
        assert_eq!(revoker.calls.lock().unwrap().len(), 1);
    }
}
