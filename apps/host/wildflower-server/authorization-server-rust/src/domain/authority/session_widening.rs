//! [`ClaimedSessionWidening`] — the authority a widened browser session's
//! new token is minted under: a session widening the Owner approved, claimed
//! once by the limited page of the browser whose session it widened. Only
//! that browser's session cookie names the session the widening was asked in,
//! so the claim is proof that the browser now polling is the one the Owner
//! widened. The token is issued to the browser-session client
//! ([`BROWSER_SESSION_CLIENT_ID`]), names the same session as its `sid`, and
//! carries what the session holds now, as its row records it.

use chrono::{DateTime, Utc};

use crate::domain::authorization_request::session_widening::SessionWideningRequest;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::browser_session::{BrowserSession, StaleSessionCutoff};
use crate::domain::grant_store::{AuthorizationRequestsTx, BrowserSessionsTx};
use crate::BROWSER_SESSION_CLIENT_ID;

/// An approved session widening, atomically claimed (`approved` → `claimed`)
/// so it mints one wider token at most. Carries the widened session as it
/// stands, which the minter mints under.
pub(crate) struct ClaimedSessionWidening {
    /// The widened session, live when the claim landed: the token's `scope`,
    /// `sid` and expiry are read off it.
    session: BrowserSession,
}

impl ClaimedSessionWidening {
    /// Claim `widening_request`, as read, in the caller's write scope `tx`.
    /// When this call wins the claim, the proof holds the session the
    /// widening widened, as its row stands at `now`. `None` when the widening
    /// isn't approved and unexpired, its session has ended (or is stale under
    /// `stale_session_cutoff`), or a concurrent poll claimed it first.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn claim(
        tx: &mut (impl AuthorizationRequestsTx + BrowserSessionsTx),
        widening_request: &SessionWideningRequest,
        stale_session_cutoff: &StaleSessionCutoff,
        now: DateTime<Utc>,
    ) -> Result<Option<Self>, AuthorizationServerError> {
        let Ok(claimed) = widening_request.claim(now) else {
            return Ok(None);
        };
        let Some(session) = tx
            .browser_session_by_sid(&widening_request.sid)?
            .filter(|session| session.is_live_at(now, stale_session_cutoff))
        else {
            return Ok(None);
        };
        if !tx.replace_session_widening_request(widening_request, &claimed)? {
            return Ok(None);
        }
        Ok(Some(ClaimedSessionWidening { session }))
    }

    /// The browser-session client, the token's `sub`.
    pub(super) fn client_id(&self) -> &str {
        BROWSER_SESSION_CLIENT_ID
    }

    /// What the widened session holds, the token's `scope`.
    pub(super) fn token_scopes(&self) -> &[String] {
        &self.session.scopes
    }

    /// The widened session: the token's `sid`, and when it ends, which the
    /// token's lifetime matches.
    pub(crate) fn session(&self) -> &BrowserSession {
        &self.session
    }
}

#[cfg(test)]
mod tests {
    use chrono::Duration;

    use super::*;
    use crate::domain::authorization_request::session_widening::NewSessionWideningRequestArgs;
    use crate::domain::authorization_request::RequestStatus;
    use crate::domain::test_fake::{approve_stored, FakeGrantStore};

    /// A paired session `sid-1` holding `wildflower/launch` and
    /// `wildflower/Apps.r`, as an approved widening leaves it, and a widening
    /// `widen-1` of it, stored pending.
    fn widened_session_and_widening(store: &FakeGrantStore) -> SessionWideningRequest {
        store
            .tx()
            .insert_browser_session(&BrowserSession {
                sid: "sid-1".to_owned(),
                ..BrowserSession::new_paired_session(
                    "Firefox on Linux".to_owned(),
                    vec![
                        "wildflower/launch".to_owned(),
                        "wildflower/Apps.r".to_owned(),
                    ],
                    Duration::hours(24),
                    Utc::now(),
                )
            })
            .unwrap();
        let widening = SessionWideningRequest::new(
            NewSessionWideningRequestArgs {
                id: "widen-1".to_owned(),
                sid: "sid-1".to_owned(),
                client_id: "app".to_owned(),
                browser_name: "Firefox on Linux".to_owned(),
                requested_scopes: vec!["wildflower/Apps.r".to_owned()],
                ttl: Duration::minutes(5),
            },
            Utc::now(),
        );
        store
            .tx()
            .insert_session_widening_request(&widening)
            .unwrap();
        widening
    }

    /// The widening `widen-1` as the store holds it now.
    fn stored(store: &FakeGrantStore) -> SessionWideningRequest {
        store
            .tx()
            .session_widening_request_by_id("widen-1")
            .unwrap()
            .expect("stored")
    }

    /// An approved widening is claimed once, and the proof carries the
    /// session as its row stands; a pending one isn't claimable.
    #[test]
    fn an_approved_widening_is_claimed_once_for_the_session_as_it_stands() {
        let store = FakeGrantStore::default();
        let pending = widened_session_and_widening(&store);
        assert!(ClaimedSessionWidening::claim(
            &mut store.tx(),
            &pending,
            &StaleSessionCutoff::none(),
            Utc::now(),
        )
        .unwrap()
        .is_none());
        approve_stored(&store, "widen-1", &["wildflower/Apps.r"], None);
        let approved = stored(&store);
        let claimed = ClaimedSessionWidening::claim(
            &mut store.tx(),
            &approved,
            &StaleSessionCutoff::none(),
            Utc::now(),
        )
        .unwrap()
        .expect("claims");
        assert_eq!(claimed.session().sid, "sid-1");
        assert_eq!(
            claimed.token_scopes(),
            ["wildflower/launch", "wildflower/Apps.r"]
        );
        assert_eq!(claimed.client_id(), BROWSER_SESSION_CLIENT_ID);
        assert_eq!(stored(&store).state.status(), RequestStatus::Claimed);
        assert!(ClaimedSessionWidening::claim(
            &mut store.tx(),
            &approved,
            &StaleSessionCutoff::none(),
            Utc::now(),
        )
        .unwrap()
        .is_none());
    }

    /// A widening whose session has ended since is not claimed, and stays
    /// approved.
    #[test]
    fn a_widening_of_an_ended_session_is_not_claimed() {
        let store = FakeGrantStore::default();
        widened_session_and_widening(&store);
        approve_stored(&store, "widen-1", &["wildflower/Apps.r"], None);
        store
            .tx()
            .revoke_browser_session("sid-1", Utc::now())
            .unwrap();
        let approved = stored(&store);
        assert!(ClaimedSessionWidening::claim(
            &mut store.tx(),
            &approved,
            &StaleSessionCutoff::none(),
            Utc::now(),
        )
        .unwrap()
        .is_none());
        assert_eq!(stored(&store).state.status(), RequestStatus::Approved);
    }
}
