//! [`SessionEnder`] — logout's self-revoke: denylist the caller's *own* token.
//! Built from the caller's verified claims, so it can revoke nothing but the
//! token that was presented.

use std::sync::Arc;

use crate::domain::session::revoke_session_token;
use crate::domain::token::VerifiedClaims;
use crate::ports::Revocation;

/// End the caller's own session. Holds the [`Revocation`] port lifted from the
/// state and the caller's claims handed over by the extractor.
pub(crate) struct SessionEnder {
    revocation: Arc<dyn Revocation>,
    claims: VerifiedClaims,
}

impl SessionEnder {
    /// Build the ender over the revocation port and the caller's own claims.
    pub(crate) fn new(revocation: Arc<dyn Revocation>, claims: VerifiedClaims) -> Self {
        SessionEnder { revocation, claims }
    }

    /// Denylist the presented token's `jti` until its `exp`, so a leaked copy
    /// can't outlive the logout. Best-effort by design (see
    /// [`revoke_session_token`]): a legacy token with no `jti` or `exp` has
    /// nothing to denylist, and a store hiccup is logged, never surfaced — the
    /// logout's redirect must not be blocked.
    pub(crate) fn end(&self) {
        let (Some(jti), Some(expires_at)) = (self.claims.jti.as_deref(), self.claims.expires_at)
        else {
            return;
        };
        revoke_session_token(self.revocation.as_ref(), jti, expires_at);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use chrono::{DateTime, Utc};

    use super::*;

    #[derive(Default)]
    struct RecordingRevoker {
        calls: Mutex<Vec<String>>,
    }

    impl Revocation for RecordingRevoker {
        fn revoke_jti(
            &self,
            jti: &str,
            _expires_at: DateTime<Utc>,
            _reason: &str,
        ) -> Result<(), String> {
            self.calls.lock().unwrap().push(jti.to_owned());
            Ok(())
        }

        fn revoke_subject_as_of_now(&self, _subject: &str) -> Result<(), String> {
            unreachable!("logout revokes a jti, never a subject")
        }
    }

    fn claims(jti: Option<&str>, expires_at: Option<DateTime<Utc>>) -> VerifiedClaims {
        VerifiedClaims {
            issuer: "iss".to_owned(),
            subject: "client".to_owned(),
            jti: jti.map(str::to_owned),
            audience: vec![],
            expires_at,
            issued_at: None,
            scope: None,
            patient: None,
            host_owner: None,
        }
    }

    /// The ender revokes exactly the presented token's `jti`, and a token with
    /// no `jti` or `exp` revokes nothing.
    #[test]
    fn end_revokes_only_the_presented_jti() {
        let revoker = Arc::new(RecordingRevoker::default());
        SessionEnder::new(revoker.clone(), claims(Some("jti-1"), Some(Utc::now()))).end();
        SessionEnder::new(revoker.clone(), claims(None, Some(Utc::now()))).end();
        SessionEnder::new(revoker.clone(), claims(Some("jti-2"), None)).end();
        assert_eq!(*revoker.calls.lock().unwrap(), vec!["jti-1".to_owned()]);
    }
}
