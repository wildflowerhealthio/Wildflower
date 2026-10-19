//! [`AuthorizationStatusReader`] — `GET /oauth/authorize/{id}`, the wait page's
//! polling view of an authorization request as it moves from pending toward
//! approval or denial. It answers the browser session the request was made
//! in, and a browser session whose grant covers [`any_request_status_scopes`],
//! so a leaked request id alone can't collect the code; its only power is this
//! one read.

use chrono::{DateTime, Utc};
use url::Url;
use wildflowerhealthio_scopes::{Grant, Scope};

use crate::domain::authorization_request::{CodeRequest, RequestStatus};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::access::consents::{
    consent_decider_scopes, consent_reader_scopes,
};
use crate::domain::grant_store::{AuthorizationCodesTx as _, AuthorizationRequestsTx as _};
use crate::domain::GrantStore;

/// The scopes that let a browser session read the status of a code-flow
/// request made in another browser session: the ones that load the request on
/// the consent card and decide it there, `wildflower/AuthorizationRequest.r`
/// and `wildflower/AuthorizationRequest.u`. A session holding them could
/// approve the request itself, and the code its status carries is bound by
/// PKCE to the client that asked, so the read gives it nothing new.
pub(crate) fn any_request_status_scopes() -> Vec<Scope> {
    [consent_reader_scopes(), consent_decider_scopes()].concat()
}

/// The browser session a status poll arrives in: its `sid`, and the grant its
/// verified token carries.
#[derive(Debug)]
pub(crate) struct PollingBrowserSession {
    pub(crate) sid: String,
    pub(crate) grant: Grant,
}

impl PollingBrowserSession {
    /// Whether this session may read the status of the code request
    /// `code_request`: it was made in this session, or this session's grant
    /// covers [`any_request_status_scopes`].
    fn may_read(&self, code_request: &CodeRequest) -> bool {
        code_request.sid == self.sid || self.grant.covers_all(&any_request_status_scopes())
    }
}

/// Where a polled request stands.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AuthorizationStatusView {
    Pending,
    /// Denied: the client callback, which carries `error=access_denied` so the
    /// wait page can complete the flow.
    Denied {
        redirect_uri: Url,
        client_state: String,
    },
    /// Approved: the client callback carrying the issued code.
    Approved {
        redirect_uri: Url,
        code: String,
        client_state: String,
    },
    /// The request expired before a decision.
    Expired,
}

/// The ways the status read can fail. `NotFound` is the polling endpoint's
/// 404; `ApprovedWithoutCode` is an invariant violation (an approved code
/// request always has its code).
#[derive(Debug)]
pub(crate) enum AuthorizationStatusError {
    NotFound { id: String },
    ApprovedWithoutCode,
    Store(AuthorizationServerError),
}

impl From<AuthorizationServerError> for AuthorizationStatusError {
    fn from(error: AuthorizationServerError) -> Self {
        AuthorizationStatusError::Store(error)
    }
}

/// Read authorization-request status. Generic over the store port so it's
/// unit-testable against the fake; the binding instantiates it over the
/// concrete `SqliteGrantStore`.
pub(crate) struct AuthorizationStatusReader<S: GrantStore> {
    store: S,
}

impl<S: GrantStore> AuthorizationStatusReader<S> {
    /// Build the reader over a store handle lifted from the state.
    pub(crate) fn new(store: S) -> Self {
        AuthorizationStatusReader { store }
    }

    /// The current status of the code request `id`, for the browser holding
    /// the browser session `poller` (`None` when it holds none). A pending
    /// request past its expiry reads as expired, and so does a claimed one.
    ///
    /// A request `poller` may not read (see [`PollingBrowserSession`]), a
    /// device request or a browser pairing (each has its own poll), and any
    /// request when there is no `poller`, is
    /// [`AuthorizationStatusError::NotFound`], the same as an unknown id, so
    /// the read says nothing about whether `id` exists.
    ///
    /// # Errors
    ///
    /// See [`AuthorizationStatusError`].
    pub(crate) fn status(
        &self,
        id: &str,
        poller: Option<&PollingBrowserSession>,
        now: DateTime<Utc>,
    ) -> Result<AuthorizationStatusView, AuthorizationStatusError> {
        self.store.read(|tx| {
            let request = tx
                .authorization_request_by_id(id)?
                .filter(|request| {
                    request.code().is_some_and(|code_request| {
                        poller.is_some_and(|poller| poller.may_read(code_request))
                    })
                })
                .ok_or_else(|| AuthorizationStatusError::NotFound { id: id.to_owned() })?;
            let Some(code_request) = request.code() else {
                return Err(AuthorizationStatusError::NotFound { id: id.to_owned() });
            };
            Ok(match request.status() {
                RequestStatus::Pending if request.is_expired_at(now) => {
                    AuthorizationStatusView::Expired
                }
                RequestStatus::Pending => AuthorizationStatusView::Pending,
                RequestStatus::Claimed => AuthorizationStatusView::Expired,
                RequestStatus::Denied => AuthorizationStatusView::Denied {
                    redirect_uri: code_request.redirect_uri.clone(),
                    client_state: code_request.client_state.clone(),
                },
                RequestStatus::Approved => {
                    let code = tx
                        .authorization_code_by_request_id(id)?
                        .ok_or(AuthorizationStatusError::ApprovedWithoutCode)?;
                    AuthorizationStatusView::Approved {
                        redirect_uri: code_request.redirect_uri.clone(),
                        code: code.code,
                        client_state: code_request.client_state.clone(),
                    }
                }
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::domain::grant_store::*;
    use chrono::Duration;
    use wildflowerhealthio_scopes::{render_scopes, Permission, WildflowerResource};

    use super::*;
    use crate::domain::authorization_code::{IssuedAuthorizationCode, AUTHORIZATION_CODE_TTL};
    use crate::domain::test_fake::{code_request, device_request, FakeGrantStore, FIXTURE_SID};

    /// A browser session `sid` holding `scopes`.
    fn session(sid: &str, scopes: Vec<Scope>) -> PollingBrowserSession {
        PollingBrowserSession {
            sid: sid.to_owned(),
            grant: Grant::new(scopes),
        }
    }

    /// The browser session the fixture requests were made in, holding nothing.
    fn requester() -> PollingBrowserSession {
        session(FIXTURE_SID, Vec::new())
    }

    /// Each stored status maps to its view; a pending request past its TTL
    /// reads as expired; an unknown id is not found.
    #[test]
    fn status_reports_each_state_and_expires_stale_pending_requests() {
        let store = FakeGrantStore::default();
        let now = Utc::now();
        store
            .tx()
            .insert_authorization_request(&code_request(
                "pending",
                RequestStatus::Pending,
                now + Duration::minutes(5),
            ))
            .unwrap();
        store
            .tx()
            .insert_authorization_request(&code_request(
                "stale",
                RequestStatus::Pending,
                now - Duration::minutes(1),
            ))
            .unwrap();
        store
            .tx()
            .insert_authorization_request(&code_request(
                "denied",
                RequestStatus::Denied,
                now + Duration::minutes(5),
            ))
            .unwrap();
        store
            .tx()
            .insert_authorization_request(&code_request(
                "approved",
                RequestStatus::Approved,
                now + Duration::minutes(5),
            ))
            .unwrap();
        store
            .tx()
            .issue_authorization_code(&IssuedAuthorizationCode {
                code: "the-code".to_owned(),
                request_id: "approved".to_owned(),
                client_id: "client".to_owned(),
                redirect_uri: Url::parse("https://example.com/cb").unwrap(),
                code_challenge: "c".repeat(43),
                granted_scopes: vec!["read".to_owned()],
                patient: None,
                issued_at: now,
                expires_at: now + AUTHORIZATION_CODE_TTL,
                sid: FIXTURE_SID.to_owned(),
            })
            .unwrap();
        let reader = AuthorizationStatusReader::new(store);
        let requester = requester();

        assert_eq!(
            reader.status("pending", Some(&requester), now).unwrap(),
            AuthorizationStatusView::Pending
        );
        assert_eq!(
            reader.status("stale", Some(&requester), now).unwrap(),
            AuthorizationStatusView::Expired
        );
        assert!(matches!(
            reader.status("denied", Some(&requester), now).unwrap(),
            AuthorizationStatusView::Denied { .. }
        ));
        assert_eq!(
            reader.status("approved", Some(&requester), now).unwrap(),
            AuthorizationStatusView::Approved {
                redirect_uri: Url::parse("https://example.com/cb").unwrap(),
                code: "the-code".to_owned(),
                client_state: "state".to_owned(),
            }
        );
        assert!(matches!(
            reader.status("ghost", Some(&requester), now),
            Err(AuthorizationStatusError::NotFound { .. })
        ));
    }

    /// The browser session a request was made in reads its status, and so
    /// does a session whose grant covers [`any_request_status_scopes`]. A
    /// session lacking either of them, no session, and anyone polling a
    /// request made in no session (a device request) get the same not-found
    /// as an unknown id.
    #[test]
    fn status_answers_the_requesting_session_and_sessions_that_decide_consents() {
        let store = FakeGrantStore::default();
        let now = Utc::now();
        store
            .tx()
            .insert_authorization_request(&code_request(
                "parked",
                RequestStatus::Pending,
                now + Duration::minutes(5),
            ))
            .unwrap();
        store
            .tx()
            .insert_authorization_request(&device_request("device", "CODE", RequestStatus::Pending))
            .unwrap();
        let reader = AuthorizationStatusReader::new(store);
        let request_reader =
            Scope::wildflower(WildflowerResource::AuthorizationRequest, Permission::READ);
        let request_decider =
            Scope::wildflower(WildflowerResource::AuthorizationRequest, Permission::UPDATE);
        let decider = session("owner-sid", any_request_status_scopes());

        for poller in [&requester(), &decider] {
            assert_eq!(
                reader.status("parked", Some(poller), now).unwrap(),
                AuthorizationStatusView::Pending,
                "{poller:?}"
            );
        }
        for (id, poller) in [
            ("parked", Some(session("another-sid", Vec::new()))),
            ("parked", Some(session("reader-sid", vec![request_reader]))),
            (
                "parked",
                Some(session("decider-sid", vec![request_decider])),
            ),
            ("parked", None),
            ("device", Some(requester())),
            (
                "device",
                Some(session("owner-sid", any_request_status_scopes())),
            ),
            ("device", None),
        ] {
            assert!(
                matches!(
                    reader.status(id, poller.as_ref(), now),
                    Err(AuthorizationStatusError::NotFound { .. })
                ),
                "{id} polled from {poller:?}"
            );
        }
    }

    /// The scopes that read any code-flow request's status are the consent
    /// card's: `AuthorizationRequest.r` and `.u`.
    #[test]
    fn any_request_status_scopes_are_authorization_request_read_and_update() {
        assert_eq!(
            render_scopes(&any_request_status_scopes()),
            [
                "wildflower/AuthorizationRequest.r",
                "wildflower/AuthorizationRequest.u"
            ]
        );
    }
}
