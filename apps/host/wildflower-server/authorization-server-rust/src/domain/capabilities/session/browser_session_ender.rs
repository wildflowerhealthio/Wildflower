//! [`BrowserSessionEnder`] — sign-out's self-revoke: end the browser session
//! the browser's own cookie holds. Built from the claims of that cookie's
//! token, which the token verifier accepted, so it can end no other session.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use crate::domain::access_token::VerifiedClaims;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::access::revoke_browser_session;
use crate::domain::GrantStore;
use crate::ports::OwnerApproval;

/// End a browser's own browser session. Holds the store and the republish
/// port lifted from the state.
pub(crate) struct BrowserSessionEnder<S: GrantStore> {
    /// The store holding the browser session the ender revokes.
    store: S,
    /// Republishes the Owner prompt once ending the session has denied a
    /// widening the Owner was being asked about.
    owner_approval: Arc<dyn OwnerApproval>,
}

impl<S: GrantStore> BrowserSessionEnder<S> {
    /// Build the ender over a store handle and the republish port, lifted
    /// from the state.
    pub(crate) fn new(store: S, owner_approval: Arc<dyn OwnerApproval>) -> Self {
        BrowserSessionEnder {
            store,
            owner_approval,
        }
    }

    /// Revoke, at `now`, the browser session `session_claims` name (their
    /// `sid`), ending everything minted under it. Claims with no `sid` name
    /// no session and end nothing; a session already revoked keeps its first
    /// revocation time. The row is kept, stamped revoked, so the token
    /// verifier refuses every token naming it from then on. The session's
    /// widenings still waiting for the Owner are denied
    /// ([`revoke_browser_session`]), and the Owner prompt republished when
    /// one was.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] when the revoke fails.
    pub(crate) fn end(
        &self,
        session_claims: &VerifiedClaims,
        now: DateTime<Utc>,
    ) -> Result<(), AuthorizationServerError> {
        if let Some(sid) = session_claims.sid.as_deref() {
            let revoked_session = self
                .store
                .write(|tx| revoke_browser_session(tx, sid, now))?;
            if revoked_session.widenings_denied {
                self.owner_approval.republish_active();
            }
        }
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

    /// Ending revokes exactly the session the claims name.
    #[test]
    fn end_revokes_only_the_named_session() {
        let store = FakeGrantStore::default();
        let now = Utc::now();
        let signed_out = BrowserSession::new_same_device_session(vec![], Duration::hours(8), now);
        let other = BrowserSession::new_same_device_session(vec![], Duration::hours(8), now);
        store.tx().insert_browser_session(&signed_out).unwrap();
        store.tx().insert_browser_session(&other).unwrap();
        let ender = BrowserSessionEnder::new(store);

        ender.end(&claims(Some(&signed_out.sid)), now).unwrap();
        ender.end(&claims(None), now).unwrap();

        assert!(ender
            .store
            .tx()
            .is_browser_session_revoked(&signed_out.sid)
            .unwrap());
        assert!(!ender
            .store
            .tx()
            .is_browser_session_revoked(&other.sid)
            .unwrap());
    }
}
