//! [`BrowserSessionEnder`] — sign-out's self-revoke: end the browser session
//! the browser's own cookie holds. Built from the claims of that cookie's
//! token, which the token verifier accepted, so it can end no other session.

use chrono::{DateTime, Utc};

use crate::domain::access_token::VerifiedClaims;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::grant_store::BrowserSessionsTx as _;
use crate::domain::GrantStore;

/// End a browser's own browser session. Holds the store lifted from the state.
pub(crate) struct BrowserSessionEnder<S: GrantStore> {
    store: S,
}

impl<S: GrantStore> BrowserSessionEnder<S> {
    /// Build the ender over a store handle lifted from the state.
    pub(crate) fn new(store: S) -> Self {
        BrowserSessionEnder { store }
    }

    /// Revoke, at `now`, the browser session `session_claims` name (their
    /// `sid`), ending everything minted under it. Claims with no `sid` name
    /// no session and end nothing; a session already revoked stays as it was.
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
            self.store.write(|tx| tx.revoke_browser_session(sid, now))?;
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
