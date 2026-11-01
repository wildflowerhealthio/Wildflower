//! Session-token operations: logout's revoke of the caller's own token, kept
//! out of the logout handler so the best-effort denylist decision is a pure,
//! testable domain operation over the [`Revocation`]
//! port (no real revocation store in the way).

use chrono::{DateTime, Utc};

use crate::ports::Revocation;

/// Denylist the logged-out session token's `jti` as of `now`, until the token's
/// own `token_expires_at`, so a leaked copy of the token can't be replayed after
/// logout.
///
/// **Best-effort by design:** the `/authorization` gate already verified the request's
/// token, so this only recovers the trusted `jti` + `exp` to denylist; any store
/// hiccup (already revoked, transient failure) must never fail the logout — the
/// client has already forgotten the token — so a failure is logged and
/// swallowed rather than returned.
pub(crate) fn revoke_session_token(
    revoker: &(impl Revocation + ?Sized),
    jti: &str,
    now: DateTime<Utc>,
    token_expires_at: DateTime<Utc>,
) {
    if let Err(error) = revoker.revoke_jti(jti, now, token_expires_at, "logout") {
        tracing::warn!(%error, "logout: failed to revoke presented token jti");
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// One `revoke_jti` call, as the recording port saw it.
    #[derive(Debug, PartialEq, Eq)]
    struct RevokedJti {
        /// The revoked token's `jti`.
        jti: String,
        /// The instant the revocation takes effect.
        revoked_as_of: DateTime<Utc>,
        /// The revoked token's own expiry.
        token_expires_at: DateTime<Utc>,
        /// The audit reason.
        reason: String,
    }

    /// A [`Revocation`] port that records each `jti` revoke, and fails every
    /// one when `fail` is set.
    #[derive(Default)]
    struct RecordingRevoker {
        /// Each `revoke_jti` call, in call order.
        calls: Mutex<Vec<RevokedJti>>,
        /// Whether every revoke answers a store failure.
        fail: bool,
    }

    impl Revocation for RecordingRevoker {
        fn revoke_jti(
            &self,
            jti: &str,
            revoked_as_of: DateTime<Utc>,
            token_expires_at: DateTime<Utc>,
            reason: &str,
        ) -> Result<(), String> {
            self.calls.lock().unwrap().push(RevokedJti {
                jti: jti.to_owned(),
                revoked_as_of,
                token_expires_at,
                reason: reason.to_owned(),
            });
            if self.fail {
                Err("store unavailable".to_owned())
            } else {
                Ok(())
            }
        }

        fn revoke_subject_as_of_now(&self, _subject: &str) -> Result<(), String> {
            unreachable!("logout revokes a jti, never a subject")
        }
    }

    /// Logout denylists the token's `jti` as of now until its expiry, with the
    /// reason `logout`.
    #[test]
    fn revokes_the_jti_with_the_logout_reason() {
        let revoker = RecordingRevoker::default();
        let now = Utc::now();
        let exp = now + chrono::Duration::minutes(5);
        revoke_session_token(&revoker, "jti-1", now, exp);
        assert_eq!(
            *revoker.calls.lock().unwrap(),
            vec![RevokedJti {
                jti: "jti-1".to_owned(),
                revoked_as_of: now,
                token_expires_at: exp,
                reason: "logout".to_owned(),
            }],
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
        let now = Utc::now();
        revoke_session_token(&revoker, "jti-1", now, now);
        assert_eq!(revoker.calls.lock().unwrap().len(), 1);
    }
}
