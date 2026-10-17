//! [`ClaimedBrowserPairing`] — the authority an approved browser session is
//! started and its token minted under: a browser pairing the Owner approved,
//! claimed once by the poll of the page that started it. Only that page holds
//! the pairing code the request is keyed on, so the claim is proof that the
//! browser now polling is the one the Owner approved. The session holds exactly
//! the scopes the Owner granted at approval, and its token is issued to the
//! browser-session client ([`BROWSER_SESSION_CLIENT_ID`]) and names the
//! session as its `sid`.

use chrono::{DateTime, Duration, Utc};

use crate::domain::authorization_request::{AuthorizationRequest, GrantType, RequestStatus};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::browser_session::BrowserSession;
use crate::domain::GrantStore;
use crate::BROWSER_SESSION_CLIENT_ID;

/// An approved browser pairing, atomically claimed (`approved` → `expired`)
/// so it starts one session at most. Carries the approved session the claim
/// starts, which the session writer stores and the minter mints under.
pub(crate) struct ClaimedBrowserPairing {
    session: BrowserSession,
}

impl ClaimedBrowserPairing {
    /// Claim `approved_pairing`, an approved browser pairing request, in
    /// `store`. When this call wins the claim, the proof holds a new approved
    /// session named after the request's browser, with the scopes the Owner
    /// granted, lasting `session_ttl` from `now`. `None` when the request is
    /// no approved browser pairing, or a concurrent poll claimed it first.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn claim(
        store: &impl GrantStore,
        approved_pairing: &AuthorizationRequest,
        session_ttl: Duration,
        now: DateTime<Utc>,
    ) -> Result<Option<Self>, AuthorizationServerError> {
        let (
            GrantType::BrowserPairing,
            RequestStatus::Approved,
            Some(browser_name),
            Some(approved_scopes),
        ) = (
            approved_pairing.grant_type,
            approved_pairing.status,
            approved_pairing.device_name.as_ref(),
            approved_pairing.granted_scopes.as_ref(),
        )
        else {
            return Ok(None);
        };
        if !store.consume_approved_authorization_request(&approved_pairing.id)? {
            return Ok(None);
        }
        Ok(Some(ClaimedBrowserPairing {
            session: BrowserSession::new_approved(
                browser_name.clone(),
                approved_scopes.clone(),
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

    /// The approved session the claim starts: the token's `sid`, and the row
    /// the session writer stores.
    pub(crate) fn session(&self) -> &BrowserSession {
        &self.session
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::authorization_request::StartBrowserPairingArgs;
    use crate::domain::browser_session::BrowserSessionKind;
    use crate::domain::test_fake::FakeGrantStore;
    use crate::domain::GrantTx as _;

    const SESSION_TTL: Duration = Duration::hours(24);

    fn pairing(id: &str) -> AuthorizationRequest {
        AuthorizationRequest::new_browser_pairing(StartBrowserPairingArgs {
            id: id.to_owned(),
            client_id: BROWSER_SESSION_CLIENT_ID.to_owned(),
            requested_scopes: vec!["wildflower/launch".to_owned()],
            user_code: "ABCD-EFGH".to_owned(),
            browser_name: "Firefox on Linux".to_owned(),
            ttl: Duration::minutes(5),
        })
    }

    fn approved_pairing(store: &FakeGrantStore, id: &str) -> AuthorizationRequest {
        store.insert_authorization_request(&pairing(id)).unwrap();
        store
            .with_connection(|tx| {
                tx.approve_authorization_request(
                    id,
                    &["wildflower/launch".to_owned(), "system/*.rs".to_owned()],
                    None,
                    Some("Ruth's laptop"),
                )
            })
            .unwrap();
        store.authorization_request_by_id(id).unwrap().unwrap()
    }

    /// The claim starts an approved session named as approved, with the
    /// approved scopes, and claims the request once.
    #[test]
    fn an_approved_pairing_is_claimed_once_for_an_approved_session() {
        let store = FakeGrantStore::default();
        let request = approved_pairing(&store, "pairing-1");
        let now = Utc::now();
        let claimed = ClaimedBrowserPairing::claim(&store, &request, SESSION_TTL, now)
            .unwrap()
            .expect("claims");
        let session = claimed.session();
        assert_eq!(session.kind, BrowserSessionKind::Approved);
        assert_eq!(session.name.as_deref(), Some("Ruth's laptop"));
        assert_eq!(session.scopes, ["wildflower/launch", "system/*.rs"]);
        assert_eq!(session.expires_at, now + SESSION_TTL);
        assert_eq!(claimed.client_id(), BROWSER_SESSION_CLIENT_ID);
        assert_eq!(claimed.token_scopes(), session.scopes);
        assert!(
            ClaimedBrowserPairing::claim(&store, &request, SESSION_TTL, now)
                .unwrap()
                .is_none(),
            "the second claim loses"
        );
    }

    /// A pending pairing, or an approved request of another flow, claims
    /// nothing and stays as it is.
    #[test]
    fn only_an_approved_pairing_is_claimed() {
        let store = FakeGrantStore::default();
        let pending = pairing("pairing-2");
        store.insert_authorization_request(&pending).unwrap();
        assert!(
            ClaimedBrowserPairing::claim(&store, &pending, SESSION_TTL, Utc::now())
                .unwrap()
                .is_none()
        );
        let approved = approved_pairing(&store, "pairing-3");
        let approved_device_request = AuthorizationRequest {
            grant_type: GrantType::DeviceCode,
            ..approved
        };
        assert!(ClaimedBrowserPairing::claim(
            &store,
            &approved_device_request,
            SESSION_TTL,
            Utc::now()
        )
        .unwrap()
        .is_none());
        assert_eq!(
            store
                .authorization_request_by_id("pairing-3")
                .unwrap()
                .unwrap()
                .status,
            RequestStatus::Approved
        );
    }
}
