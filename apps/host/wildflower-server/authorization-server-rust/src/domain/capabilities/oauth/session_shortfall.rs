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

use std::sync::Arc;

use chrono::{DateTime, Utc};

use super::PollingBrowserSession;
use crate::domain::authority::session_shortfall;
use crate::domain::authorization_code::PendingCodeRequest;
use crate::domain::authorization_request::{GrantType, RequestStatus};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::access::consents::{deny_pending_code_request, ConsentOutcome};
use crate::domain::GrantStore;
use crate::ports::OwnerApproval;

/// What the limited page says: the app, and the requested scopes the browser's
/// session lacks.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SessionShortfallView {
    /// The client's registered name, or its `client_id` when it has no
    /// registration yet.
    pub(crate) client_name: String,
    /// The requested scopes a code issued in this session would leave out
    /// ([`session_shortfall`]), in the request's order.
    pub(crate) missing_scopes: Vec<String>,
}

/// Load request `id` for the browser session `sid` while it waits on that
/// browser's limited page: a pending, unexpired code-flow request made in
/// `sid` whose shortfall isn't acknowledged yet. Anything else (an unknown id,
/// another session's request, one acknowledged, decided or expired) is
/// [`AuthorizationServerError::AuthorizationRequestNotFound`], the status
/// poll's `404`, so the answer says nothing about whether `id` exists.
pub(crate) fn load_unacknowledged_code_request(
    store: &impl GrantStore,
    id: &str,
    sid: &str,
    now: DateTime<Utc>,
) -> Result<PendingCodeRequest, AuthorizationServerError> {
    let not_found = || AuthorizationServerError::AuthorizationRequestNotFound { id: id.to_owned() };
    store
        .authorization_request_by_id(id)?
        .filter(|request| {
            request.grant_type == GrantType::AuthorizationCode
                && request.status == RequestStatus::Pending
                && !request.session_shortfall_acknowledged
                && request.expires_at > now
                && request.sid.as_deref() == Some(sid)
        })
        .and_then(PendingCodeRequest::from_request)
        .ok_or_else(not_found)
}

/// Read and cancel requests waiting on their browser's limited page. Public
/// (the caller is the browser that made the request, identified by its
/// browser session), so its only powers are these two.
pub(crate) struct SessionShortfall<S: GrantStore> {
    store: S,
    owner_approval: Arc<dyn OwnerApproval>,
}

impl<S: GrantStore> SessionShortfall<S> {
    /// Build it over a store handle and the republish port, lifted from the
    /// state.
    pub(crate) fn new(store: S, owner_approval: Arc<dyn OwnerApproval>) -> Self {
        SessionShortfall {
            store,
            owner_approval,
        }
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
        let pending_request =
            load_unacknowledged_code_request(&self.store, id, &browser_session.sid, now)?;
        let request = pending_request.request();
        let client_name = self
            .store
            .client_by_id(&request.client_id)?
            .map_or_else(|| request.client_id.clone(), |client| client.name);
        Ok(SessionShortfallView {
            client_name,
            missing_scopes: session_shortfall(&request.requested_scopes, &browser_session.grant),
        })
    }

    /// Deny request `id`, made in the browser session `sid`, and return the
    /// client callback carrying `error=access_denied`.
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
        let not_found =
            || AuthorizationServerError::AuthorizationRequestNotFound { id: id.to_owned() };
        let pending_request = load_unacknowledged_code_request(&self.store, id, sid, now)?;
        match deny_pending_code_request(
            &self.store,
            self.owner_approval.as_ref(),
            &pending_request,
            not_found,
        )? {
            ConsentOutcome::Denied {
                redirect: Some(client_callback),
            } => Ok(client_callback),
            ConsentOutcome::Denied { redirect: None } | ConsentOutcome::Approved { .. } => {
                Err(AuthorizationServerError::infrastructure(
                    "cancel a request waiting on its limited page",
                    "a code-flow request carries its client's state",
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use chrono::Duration;
    use wildflowerhealthio_scopes::Grant;

    use super::*;
    use crate::domain::authorization_request::AuthorizationRequest;
    use crate::domain::test_fake::{
        client, code_request, FakeGrantStore, RecordingOwnerApproval, FIXTURE_SID,
    };

    /// The fixture code request `id`, asking for `patient/Patient.r` and
    /// `patient/Observation.r`, waiting on its limited page.
    fn unacknowledged(id: &str) -> AuthorizationRequest {
        AuthorizationRequest {
            requested_scopes: vec![
                "openid".to_owned(),
                "patient/Patient.r".to_owned(),
                "patient/Observation.r".to_owned(),
            ],
            session_shortfall_acknowledged: false,
            ..code_request(
                id,
                RequestStatus::Pending,
                Utc::now() + Duration::minutes(5),
            )
        }
    }

    fn browser_session(sid: &str, scopes: &[&str]) -> PollingBrowserSession {
        PollingBrowserSession {
            sid: sid.to_owned(),
            grant: Grant::parse(scopes.iter().copied()),
        }
    }

    fn session_shortfall_over(
        store: FakeGrantStore,
    ) -> (
        SessionShortfall<FakeGrantStore>,
        Arc<RecordingOwnerApproval>,
    ) {
        let owner_approval = Arc::new(RecordingOwnerApproval::default());
        (
            SessionShortfall::new(store, owner_approval.clone()),
            owner_approval,
        )
    }

    /// The page reads the app's name and what the session lacks of the
    /// request, in the request's order.
    #[test]
    fn the_read_names_the_app_and_what_the_session_lacks() {
        let store = FakeGrantStore::default();
        store
            .upsert_client(&client("client", &["patient/Patient.r"]))
            .unwrap();
        store
            .insert_authorization_request(&unacknowledged("req-1"))
            .unwrap();
        let (session_shortfall, _) = session_shortfall_over(store);
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
            .insert_authorization_request(&unacknowledged("waiting"))
            .unwrap();
        store
            .insert_authorization_request(&AuthorizationRequest {
                session_shortfall_acknowledged: true,
                ..unacknowledged("acknowledged")
            })
            .unwrap();
        store
            .insert_authorization_request(&AuthorizationRequest {
                expires_at: now - Duration::seconds(1),
                ..unacknowledged("expired")
            })
            .unwrap();
        store
            .insert_authorization_request(&AuthorizationRequest {
                status: RequestStatus::Denied,
                ..unacknowledged("denied")
            })
            .unwrap();
        let (session_shortfall, _) = session_shortfall_over(store);
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
    /// callback; a second cancel finds nothing.
    #[test]
    fn cancel_denies_the_request_and_answers_access_denied() {
        let store = FakeGrantStore::default();
        store
            .insert_authorization_request(&unacknowledged("req-1"))
            .unwrap();
        let (session_shortfall, owner_approval) = session_shortfall_over(store);
        let callback = session_shortfall
            .cancel("req-1", FIXTURE_SID, Utc::now())
            .expect("cancels");
        assert_eq!(
            callback,
            "https://example.com/cb?error=access_denied\
             &error_description=The+request+was+declined.&state=state"
        );
        assert_eq!(
            session_shortfall
                .store
                .authorization_request_by_id("req-1")
                .unwrap()
                .expect("present")
                .status,
            RequestStatus::Denied
        );
        assert_eq!(owner_approval.count(), 1);
        assert!(session_shortfall
            .cancel("req-1", FIXTURE_SID, Utc::now())
            .is_err());
    }
}
