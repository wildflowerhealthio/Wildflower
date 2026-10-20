//! [`ClaimedBrowserPairing`] — the authority a paired browser session is
//! started and its token minted under: a browser pairing the Owner approved,
//! claimed once by the poll of the page that started it. Only that page holds
//! the pairing code the request is keyed on, so the claim is proof that the
//! browser now polling is the one the Owner approved. The session holds exactly
//! the scopes the Owner granted at approval, and its token is issued to the
//! browser-session client ([`BROWSER_SESSION_CLIENT_ID`]) and names the
//! session as its `sid`.

use chrono::{DateTime, Duration, Utc};

use crate::domain::authorization_request::AuthorizationRequest;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::browser_session::BrowserSession;
use crate::domain::grant_store::{write_transition, AuthorizationRequestsTx};
use crate::BROWSER_SESSION_CLIENT_ID;

/// An approved browser pairing, atomically claimed (`approved` → `claimed`)
/// so it starts one session at most. Carries the paired session the claim
/// starts, which the session writer stores and the minter mints under.
pub(crate) struct ClaimedBrowserPairing {
    session: BrowserSession,
}

impl ClaimedBrowserPairing {
    /// Claim `approved_pairing`, an approved browser pairing request, in the
    /// caller's write scope `tx`. When this call wins the claim, the proof holds a new paired
    /// session named after the request's browser, with the scopes the Owner
    /// granted, lasting `session_ttl` from `now`. `None` when the request is
    /// no approved browser pairing, or a concurrent poll claimed it first.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn claim(
        tx: &mut impl AuthorizationRequestsTx,
        approved_pairing: &AuthorizationRequest,
        session_ttl: Duration,
        now: DateTime<Utc>,
    ) -> Result<Option<Self>, AuthorizationServerError> {
        let (Some(pairing_request), Some(approval)) =
            (approved_pairing.pairing(), approved_pairing.approval())
        else {
            return Ok(None);
        };
        if !write_transition(tx, approved_pairing.claim(now))? {
            return Ok(None);
        }
        Ok(Some(ClaimedBrowserPairing {
            session: BrowserSession::new_paired_session(
                pairing_request.browser_name.clone(),
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
    use crate::domain::authorization_request::{
        NewAuthorizationRequest, PairingRequest, RequestKind, RequestStatus,
    };
    use crate::domain::browser_session::BrowserSessionKind;

    use crate::domain::test_fake::{approve_stored, device_request, FakeGrantStore};

    const SESSION_TTL: Duration = Duration::hours(24);

    fn pairing(id: &str) -> AuthorizationRequest {
        AuthorizationRequest::new(
            NewAuthorizationRequest {
                id: id.to_owned(),
                client_id: BROWSER_SESSION_CLIENT_ID.to_owned(),
                requested_scopes: vec!["wildflower/launch".to_owned()],
                ttl: Duration::minutes(5),
                kind: RequestKind::BrowserPairing(PairingRequest {
                    user_code: format!("UC-{id}"),
                    browser_name: "Firefox on Linux".to_owned(),
                    last_polled_at: None,
                }),
            },
            Utc::now(),
        )
    }

    fn stored(store: &FakeGrantStore, id: &str) -> AuthorizationRequest {
        store
            .tx()
            .authorization_request_by_id(id)
            .unwrap()
            .expect("stored")
    }

    fn approved_pairing(store: &FakeGrantStore, id: &str) -> AuthorizationRequest {
        store
            .tx()
            .insert_authorization_request(&pairing(id))
            .unwrap();
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
        assert_eq!(stored(&store, "pairing-1").status(), RequestStatus::Claimed);
        assert!(
            ClaimedBrowserPairing::claim(&mut store.tx(), &request, SESSION_TTL, now)
                .unwrap()
                .is_none(),
            "the second claim loses"
        );
    }

    /// A pending pairing, or an approved request of another kind, claims
    /// nothing and stays as it is.
    #[test]
    fn only_an_approved_pairing_is_claimed() {
        let store = FakeGrantStore::default();
        let pending = pairing("pairing-2");
        store.tx().insert_authorization_request(&pending).unwrap();
        assert!(
            ClaimedBrowserPairing::claim(&mut store.tx(), &pending, SESSION_TTL, Utc::now())
                .unwrap()
                .is_none()
        );
        store
            .tx()
            .insert_authorization_request(&device_request("dev-1", "UC-D", RequestStatus::Pending))
            .unwrap();
        approve_stored(&store, "dev-1", &["openid"], None);
        let approved_device_request = stored(&store, "dev-1");
        assert!(ClaimedBrowserPairing::claim(
            &mut store.tx(),
            &approved_device_request,
            SESSION_TTL,
            Utc::now()
        )
        .unwrap()
        .is_none());
        assert_eq!(stored(&store, "dev-1").status(), RequestStatus::Approved);
    }
}
