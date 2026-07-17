//! Owner web-**session** operations — today just the logout token revoke, lifted
//! out of the logout handler so the best-effort denylist decision is a pure,
//! testable domain operation over the [`Revocation`](crate::ports::Revocation)
//! port (no real revocation store in the way).

use chrono::{DateTime, Utc};

use crate::ports::Revocation;

/// Denylist the logged-out session token's `jti` until `expires_at`, so a leaked
/// copy of the cookie can't be replayed after logout.
///
/// **Best-effort by design:** the `/access` gate already verified the request's
/// token, so this only recovers the trusted `jti` + `exp` to denylist; any store
/// hiccup (already revoked, transient failure) must never block the cookie clear
/// — leaving the session cookie in place would be the worse outcome — so a
/// failure is logged and swallowed rather than returned. See #218 / #269.
pub(crate) fn revoke_session_token(
    revoker: &impl Revocation,
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

    #[derive(Default)]
    struct RecordingRevoker {
        calls: Mutex<Vec<(String, DateTime<Utc>, String)>>,
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

        fn revoke_subject_as_of_now(&self, _subject: &str) -> Result<(), String> {
            unreachable!("logout revokes a jti, never a subject")
        }
    }

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

    #[test]
    fn swallows_a_store_failure_so_the_cookie_clear_still_proceeds() {
        let revoker = RecordingRevoker {
            fail: true,
            ..RecordingRevoker::default()
        };
        // Must not panic or propagate — the caller relies on this being infallible.
        revoke_session_token(&revoker, "jti-1", Utc::now());
        assert_eq!(revoker.calls.lock().unwrap().len(), 1);
    }
}
