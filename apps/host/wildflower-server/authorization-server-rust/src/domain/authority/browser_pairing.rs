//! [`ClaimedBrowserPairing`] — the authority a paired browser session is
//! started and its token minted under: a browser pairing the Owner approved,
//! claimed once by the poll of the page that started it. Only that page holds
//! the pairing code the request is keyed on, so the claim is proof that the
//! browser now polling is the one the Owner approved. The session holds exactly
//! the scopes the Owner granted at approval, and its token is issued to the
//! browser-session client ([`BROWSER_SESSION_CLIENT_ID`]) and names the
//! session as its `sid`.

use chrono::{DateTime, Duration, Utc};

use crate::domain::authorization_request::pairing::PairingRequest;
use crate::domain::authorization_request::polled::Polled as _;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::browser_session::BrowserSession;
use crate::domain::grant_store::AuthorizationRequestsTx;
use crate::BROWSER_SESSION_CLIENT_ID;

/// An approved browser pairing, atomically claimed (`approved` → `claimed`)
/// so it starts one session at most. Carries the paired session the claim
/// starts, which the session writer stores and the minter mints under.
pub(crate) struct ClaimedBrowserPairing {
    session: BrowserSession,
}

impl ClaimedBrowserPairing {
    /// Claim `pairing_request`, as read, in the caller's write scope `tx`.
    /// When this call wins the claim, the proof holds a new paired session
    /// named after the request's browser, with the scopes the Owner granted,
    /// lasting `session_ttl` from `now`. `None` when the pairing isn't
    /// approved and unexpired, or a concurrent poll claimed it first.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn claim(
        tx: &mut impl AuthorizationRequestsTx,
        pairing_request: &PairingRequest,
        session_ttl: Duration,
        now: DateTime<Utc>,
    ) -> Result<Option<Self>, AuthorizationServerError> {
        let Ok(claimed) = pairing_request.claim(now) else {
            return Ok(None);
        };
        let Some(approval) = claimed.state.approval() else {
            return Ok(None);
        };
        if !tx.replace_pairing_request(pairing_request, &claimed)? {
            return Ok(None);
        }
        Ok(Some(ClaimedBrowserPairing {
            session: BrowserSession::new_paired_session(
                claimed.browser_name.clone(),
                approval.granted_scopes.clone(),
                session_ttl,
                now,
            ),
        }))
    }

    /// The browser-session client, the token's `sub`.
    pub(super) fn client_id(&self) -> &str {
        BROWSER_SESSION_CLIENT_ID
    }

    /// The scopes the Owner granted, the token's `scope`.
    pub(super) fn token_scopes(&self) -> &[String] {
        &self.session.scopes
    }

    /// The paired session the claim starts: the token's `sid`, and the row
    /// the session writer stores.
    pub(crate) fn session(&self) -> &BrowserSession {
        &self.session
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::authorization_request::pairing::NewPairingRequestArgs;
    use crate::domain::authorization_request::RequestStatus;
    use crate::domain::browser_session::BrowserSessionKind;

    use crate::domain::test_fake::{approve_stored, FakeGrantStore};

    const SESSION_TTL: Duration = Duration::hours(24);

    fn pairing(id: &str) -> PairingRequest {
        PairingRequest::new(
            NewPairingRequestArgs {
                id: id.to_owned(),
                client_id: BROWSER_SESSION_CLIENT_ID.to_owned(),
                requested_scopes: vec!["wildflower/launch".to_owned()],
                ttl: Duration::minutes(5),
                user_code: format!("UC-{id}"),
                browser_name: "Firefox on Linux".to_owned(),
            },
            Utc::now(),
        )
    }

    fn stored(store: &FakeGrantStore, id: &str) -> PairingRequest {
        store
            .tx()
            .pairing_request_by_id(id)
            .unwrap()
            .expect("stored")
    }

    fn approved_pairing(store: &FakeGrantStore, id: &str) -> PairingRequest {
        store.tx().insert_pairing_request(&pairing(id)).unwrap();
        approve_stored(
            store,
            id,
            &["wildflower/launch", "system/*.rs"],
            Some("Ruth's laptop"),
        );
        stored(store, id)
    }

    /// The claim starts a paired session named as approved, with the
    /// approved scopes, and claims the request once.
    #[test]
    fn an_approved_pairing_is_claimed_once_for_a_paired_session() {
        let store = FakeGrantStore::default();
        let request = approved_pairing(&store, "pairing-1");
        let now = Utc::now();
        let claimed = ClaimedBrowserPairing::claim(&mut store.tx(), &request, SESSION_TTL, now)
            .unwrap()
            .expect("claims");
        let session = claimed.session();
        assert_eq!(session.kind, BrowserSessionKind::Paired);
        assert_eq!(session.name.as_deref(), Some("Ruth's laptop"));
        assert_eq!(session.scopes, ["wildflower/launch", "system/*.rs"]);
        assert_eq!(session.expires_at, now + SESSION_TTL);
        assert_eq!(claimed.client_id(), BROWSER_SESSION_CLIENT_ID);
        assert_eq!(claimed.token_scopes(), session.scopes);
        assert_eq!(
            stored(&store, "pairing-1").state.status(),
            RequestStatus::Claimed
        );
        assert!(
            ClaimedBrowserPairing::claim(&mut store.tx(), &request, SESSION_TTL, now)
                .unwrap()
                .is_none(),
            "the second claim loses"
        );
    }

    /// A pending pairing claims nothing and stays as it is.
    #[test]
    fn only_an_approved_pairing_is_claimed() {
        let store = FakeGrantStore::default();
        let pending = pairing("pairing-2");
        store.tx().insert_pairing_request(&pending).unwrap();
        assert!(
            ClaimedBrowserPairing::claim(&mut store.tx(), &pending, SESSION_TTL, Utc::now())
                .unwrap()
                .is_none()
        );
        assert_eq!(
            stored(&store, "pairing-2").state.status(),
            RequestStatus::Pending
        );
    }
}
