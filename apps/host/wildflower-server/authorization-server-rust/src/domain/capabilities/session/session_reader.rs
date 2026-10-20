//! [`SessionReader`] — the caller reading back their *own* session: what the
//! token they presented carries, and, for a token minted under a browser
//! session, when that session expires. Every field is derived from that token
//! or the session it names, so the read can't disclose anything about another
//! caller.

use chrono::{DateTime, Utc};

use crate::domain::access_token::VerifiedClaims;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::grant_store::BrowserSessionsTx as _;
use crate::domain::GrantStore;

/// Read the caller's own session. Built from the caller's claims and the
/// store, which holds the browser session the claims may name.
pub(crate) struct SessionReader<S: GrantStore> {
    store: S,
    claims: VerifiedClaims,
}

impl<S: GrantStore> SessionReader<S> {
    /// Build the reader over a store handle and the caller's own claims.
    pub(crate) fn new(store: S, claims: VerifiedClaims) -> Self {
        SessionReader { store, claims }
    }

    /// The browser session the caller's token was minted under (its `sid`),
    /// or `None` for a token under no browser session.
    pub(crate) fn sid(&self) -> Option<&str> {
        self.claims.sid.as_deref()
    }

    /// The `scope` claim split on whitespace — the scopes this session actually
    /// holds. Empty when the token carries no `scope` claim at all.
    pub(crate) fn scopes(&self) -> Vec<String> {
        self.claims
            .scope
            .as_deref()
            .unwrap_or("")
            .split_whitespace()
            .map(str::to_owned)
            .collect()
    }

    /// When the browser session the caller's token was minted under expires,
    /// or `None` for a token under no browser session (or a `sid` that names
    /// no session row).
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] when the session can't be
    /// read.
    pub(crate) fn browser_session_expires_at(
        &self,
    ) -> Result<Option<DateTime<Utc>>, AuthorizationServerError> {
        let Some(sid) = self.sid() else {
            return Ok(None);
        };
        Ok(self
            .store
            .read(|tx| tx.browser_session_by_sid(sid))?
            .map(|session| session.expires_at))
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
            subject: "client".to_owned(),
            jti: None,
            audience: vec![],
            expires_at: None,
            issued_at: None,
            scope: Some("openid wildflower/Grant.r".to_owned()),
            patient: None,
            sid: sid.map(str::to_owned),
        }
    }

    /// A token under a browser session reads back that session's expiry; a
    /// token under none, or naming no stored session, reads none.
    #[test]
    fn the_browser_session_expiry_is_the_named_session_s() {
        let store = FakeGrantStore::default();
        let session =
            BrowserSession::new_same_device_session(vec![], Duration::hours(8), Utc::now());
        store.tx().insert_browser_session(&session).expect("insert");

        let reader = SessionReader::new(store, claims(Some(&session.sid)));
        assert_eq!(
            reader.browser_session_expires_at(),
            Ok(Some(session.expires_at))
        );
        assert_eq!(reader.sid(), Some(session.sid.as_str()));
        assert_eq!(reader.scopes(), ["openid", "wildflower/Grant.r"]);

        for sid in [None, Some("no-such-sid")] {
            assert_eq!(
                SessionReader::new(FakeGrantStore::default(), claims(sid))
                    .browser_session_expires_at(),
                Ok(None),
                "{sid:?}"
            );
        }
    }
}
