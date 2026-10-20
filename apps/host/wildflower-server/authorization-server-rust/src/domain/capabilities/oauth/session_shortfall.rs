//! [`SessionShortfall`] — the limited page's side of a request whose browser
//! session holds less than the request asks for. `/oauth/authorize` parks such
//! a request unacknowledged and sends the browser to the limited page, which
//! reads what the session lacks and then goes on
//! ([`CodeAuthorizationStarter::continue_past_session_shortfall`]) or cancels.
//! Every operation answers only the browser session the request was made in,
//! so a leaked request id reads, continues and cancels nothing.
//!
//! [`CodeAuthorizationStarter::continue_past_session_shortfall`]:
//! super::CodeAuthorizationStarter::continue_past_session_shortfall

use chrono::{DateTime, Utc};

use super::PollingBrowserSession;
use crate::domain::authority::session_shortfall;
use crate::domain::authorization_request::PendingCodeRequest;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::client_redirect::{
    build_client_error_redirect_url, REQUEST_DECLINED_DESCRIPTION,
};
use crate::domain::grant_store::{write_transition, AuthorizationRequestsTx, ClientsTx as _};
use crate::domain::oauth_error_code::OAuthErrorCode;
use crate::domain::GrantStore;

/// What the limited page says: the app, and the requested scopes the browser's
/// session lacks.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SessionShortfallView {
    /// The client's registered name, or its `client_id` when it has no
    /// registration yet.
    pub(crate) client_name: String,
    /// The requested scopes a code issued in this session would not carry in
    /// full ([`session_shortfall`]), in the request's order.
    pub(crate) missing_scopes: Vec<String>,
}

/// Load request `id` for the browser session `sid` while it waits on that
/// browser's limited page: a pending, unexpired code-flow request made in
/// `sid` whose shortfall isn't acknowledged yet. Anything else (an unknown id,
/// another session's request, one acknowledged, decided or expired) is
/// [`AuthorizationServerError::AuthorizationRequestNotFound`], the status
/// poll's `404`, so the answer says nothing about whether `id` exists.
pub(crate) fn load_unacknowledged_code_request(
    tx: &mut impl AuthorizationRequestsTx,
    id: &str,
    sid: &str,
    now: DateTime<Utc>,
) -> Result<PendingCodeRequest, AuthorizationServerError> {
    let not_found = || AuthorizationServerError::AuthorizationRequestNotFound { id: id.to_owned() };
    tx.authorization_request_by_id(id)?
        .and_then(|request| request.into_pending_code(now))
        .filter(|pending_request| {
            let code_request = pending_request.code();
            !code_request.session_shortfall_acknowledged && code_request.sid == sid
        })
        .ok_or_else(not_found)
}

/// Read and cancel requests waiting on their browser's limited page. Public
/// (the caller is the browser that made the request, identified by its
/// browser session), so its only powers are these two.
pub(crate) struct SessionShortfall<S: GrantStore> {
    store: S,
}

impl<S: GrantStore> SessionShortfall<S> {
    /// Build it over a store handle lifted from the state.
    pub(crate) fn new(store: S) -> Self {
        SessionShortfall { store }
    }

    /// What request `id` asks for that `browser_session`'s grant doesn't
    /// hold, and the app asking.
    ///
    /// # Errors
    ///
    /// See [`load_unacknowledged_code_request`]; the store's.
    pub(crate) fn read(
        &self,
        id: &str,
        browser_session: &PollingBrowserSession,
        now: DateTime<Utc>,
    ) -> Result<SessionShortfallView, AuthorizationServerError> {
        self.store.read(|tx| {
            let pending_request =
                load_unacknowledged_code_request(tx, id, &browser_session.sid, now)?;
            let request = pending_request.request();
            let client_name = tx
                .client_by_id(request.client_id())?
                .map_or_else(|| request.client_id().to_owned(), |client| client.name);
            Ok(SessionShortfallView {
                client_name,
                missing_scopes: session_shortfall(
                    request.requested_scopes(),
                    &browser_session.grant,
                ),
            })
        })
    }

    /// Deny request `id`, made in the browser session `sid`, and return the
    /// client callback carrying `error=access_denied`. The denial holds only
    /// while the request still waits on the page, so a Continue that
    /// acknowledged it meanwhile wins and this answers not found. The Owner
    /// was never told of a request still waiting here, so nothing is
    /// republished.
    ///
    /// # Errors
    ///
    /// See [`load_unacknowledged_code_request`]; the store's.
    pub(crate) fn cancel(
        &self,
        id: &str,
        sid: &str,
        now: DateTime<Utc>,
    ) -> Result<String, AuthorizationServerError> {
        let pending_request = self.store.write(|tx| {
            let pending_request = load_unacknowledged_code_request(tx, id, sid, now)?;
            if write_transition(tx, pending_request.request().deny_on_limited_page(now))? {
                Ok(pending_request)
            } else {
                Err(AuthorizationServerError::AuthorizationRequestNotFound { id: id.to_owned() })
            }
        })?;
        let code_request = pending_request.code();
        Ok(build_client_error_redirect_url(
            &code_request.redirect_uri,
            OAuthErrorCode::AccessDenied,
            REQUEST_DECLINED_DESCRIPTION,
            &code_request.client_state,
        ))
    }
}

#[cfg(test)]
mod tests {
    use crate::domain::grant_store::*;
    use chrono::Duration;
    use wildflowerhealthio_scopes::Grant;

    use super::*;
    use crate::domain::authorization_request::{
        AuthorizationRequest, CodeRequest, RequestKind, RequestStatus,
    };
    use crate::domain::test_fake::{
        client, fixture_code, pending_request, with_status, FakeGrantStore, FIXTURE_SID,
    };

    /// A code request `id`, asking for `patient/Patient.r` and
    /// `patient/Observation.r`, expiring at `expires_at`, whose browser has
    /// gone on past its limited page or not.
    fn code_request(
        id: &str,
        expires_at: DateTime<Utc>,
        session_shortfall_acknowledged: bool,
    ) -> AuthorizationRequest {
        pending_request(
            id,
            &["openid", "patient/Patient.r", "patient/Observation.r"],
            expires_at,
            RequestKind::AuthorizationCode(CodeRequest {
                session_shortfall_acknowledged,
                ..fixture_code()
            }),
        )
    }

    /// [`code_request`] `id`, live for five minutes, waiting on its limited
    /// page.
    fn unacknowledged(id: &str) -> AuthorizationRequest {
        code_request(id, Utc::now() + Duration::minutes(5), false)
    }

    fn status_of(session_shortfall: &SessionShortfall<FakeGrantStore>, id: &str) -> RequestStatus {
        session_shortfall
            .store
            .tx()
            .authorization_request_by_id(id)
            .unwrap()
            .expect("present")
            .status()
    }

    fn browser_session(sid: &str, scopes: &[&str]) -> PollingBrowserSession {
        PollingBrowserSession {
            sid: sid.to_owned(),
            grant: Grant::parse(scopes.iter().copied()),
        }
    }

    /// The page reads the app's name and what the session lacks of the
    /// request, in the request's order.
    #[test]
    fn the_read_names_the_app_and_what_the_session_lacks() {
        let store = FakeGrantStore::default();
        store
            .tx()
            .upsert_client(&client("client", &["patient/Patient.r"]))
            .unwrap();
        store
            .tx()
            .insert_authorization_request(&unacknowledged("req-1"))
            .unwrap();
        let session_shortfall = SessionShortfall::new(store);
        let view = session_shortfall
            .read(
                "req-1",
                &browser_session(FIXTURE_SID, &["patient/Patient.rs"]),
                Utc::now(),
            )
            .expect("the requesting session reads it");
        assert_eq!(
            view,
            SessionShortfallView {
                client_name: "client display name".to_owned(),
                missing_scopes: vec!["patient/Observation.r".to_owned()],
            }
        );
    }

    /// Another session, an acknowledged request, an expired one, a decided
    /// one and an unknown id all read as not found.
    #[test]
    fn only_the_requesting_session_reads_a_request_still_waiting_on_its_page() {
        let store = FakeGrantStore::default();
        let now = Utc::now();
        store
            .tx()
            .insert_authorization_request(&unacknowledged("waiting"))
            .unwrap();
        store
            .tx()
            .insert_authorization_request(&code_request(
                "acknowledged",
                now + Duration::minutes(5),
                true,
            ))
            .unwrap();
        store
            .tx()
            .insert_authorization_request(&code_request(
                "expired",
                now - Duration::seconds(1),
                false,
            ))
            .unwrap();
        store
            .tx()
            .insert_authorization_request(&with_status(
                unacknowledged("denied"),
                RequestStatus::Denied,
            ))
            .unwrap();
        let session_shortfall = SessionShortfall::new(store);
        for (id, sid) in [
            ("waiting", "another-sid"),
            ("acknowledged", FIXTURE_SID),
            ("expired", FIXTURE_SID),
            ("denied", FIXTURE_SID),
            ("ghost", FIXTURE_SID),
        ] {
            assert_eq!(
                session_shortfall.read(id, &browser_session(sid, &[]), now),
                Err(AuthorizationServerError::AuthorizationRequestNotFound { id: id.to_owned() }),
                "{id} from {sid}"
            );
            assert_eq!(
                session_shortfall.cancel(id, sid, now),
                Err(AuthorizationServerError::AuthorizationRequestNotFound { id: id.to_owned() }),
                "{id} from {sid}"
            );
        }
    }

    /// Cancel denies the request and hands back the client's `access_denied`
    /// callback, and remembers nothing for the session; a second cancel finds
    /// nothing.
    #[test]
    fn cancel_denies_the_request_and_answers_access_denied() {
        let store = FakeGrantStore::default();
        store
            .tx()
            .insert_authorization_request(&unacknowledged("req-1"))
            .unwrap();
        let session_shortfall = SessionShortfall::new(store);
        let callback = session_shortfall
            .cancel("req-1", FIXTURE_SID, Utc::now())
            .expect("cancels");
        assert_eq!(
            callback,
            "https://example.com/cb?error=access_denied\
             &error_description=The+request+was+declined.&state=state"
        );
        assert_eq!(
            status_of(&session_shortfall, "req-1"),
            RequestStatus::Denied
        );
        assert!(!session_shortfall
            .store
            .tx()
            .is_session_shortfall_acknowledged_for_client(FIXTURE_SID, "client")
            .unwrap());
        assert!(session_shortfall
            .cancel("req-1", FIXTURE_SID, Utc::now())
            .is_err());
    }

    /// A Cancel that read the request before a Continue acknowledged it
    /// doesn't deny it after: the Continue wins and the Cancel lands nowhere.
    #[test]
    fn a_cancel_racing_a_continue_leaves_the_acknowledged_request_alone() {
        let store = FakeGrantStore::default();
        store
            .tx()
            .insert_authorization_request(&unacknowledged("req-1"))
            .unwrap();
        let session_shortfall = SessionShortfall::new(store);
        let now = Utc::now();
        let read_by_cancel = load_unacknowledged_code_request(
            &mut session_shortfall.store.tx(),
            "req-1",
            FIXTURE_SID,
            now,
        )
        .expect("the Cancel reads it first");
        let continued = read_by_cancel
            .request()
            .acknowledge_session_shortfall(Duration::minutes(5), now)
            .expect("the Continue acknowledges it");
        assert!(session_shortfall
            .store
            .tx()
            .replace_authorization_request(&continued)
            .unwrap());
        let cancelled = read_by_cancel
            .request()
            .deny_on_limited_page(now)
            .expect("the Cancel's read still waits");
        assert!(!session_shortfall
            .store
            .tx()
            .replace_authorization_request(&cancelled)
            .unwrap());
        assert_eq!(
            status_of(&session_shortfall, "req-1"),
            RequestStatus::Pending
        );
    }
}
