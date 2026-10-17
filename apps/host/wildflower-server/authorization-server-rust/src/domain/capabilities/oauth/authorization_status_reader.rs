//! [`AuthorizationStatusReader`] — `GET /oauth/authorize/{id}`, the wait page's
//! polling view of an authorization request as it moves from pending toward
//! approval or denial. It answers only the browser session the request was
//! made in, so a leaked request id alone can't collect the code; its only
//! power is this one read.

use chrono::{DateTime, Utc};
use url::Url;

use crate::domain::authorization_request::RequestStatus;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::GrantStore;

/// Where a polled request stands.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AuthorizationStatusView {
    Pending,
    /// Denied; for a code-flow request the client callback carrying
    /// `error=access_denied` so the wait page can complete the flow.
    Denied {
        redirect_uri: Option<Url>,
        client_state: Option<String>,
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
/// 404; the two `Approved*` variants are invariant violations (an approved
/// code-flow request always has a redirect, state, and code).
#[derive(Debug)]
pub(crate) enum AuthorizationStatusError {
    NotFound { id: String },
    ApprovedWithoutRedirect,
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

    /// The current status of request `id`, for the browser holding the
    /// browser session `polling_sid` (`None` when it holds none). Nothing
    /// actively transitions code-flow requests from pending to expired, so a
    /// pending request past its TTL is reported expired here rather than left
    /// polling forever.
    ///
    /// A request made in another browser session, or in none (a device
    /// request, a browser pairing), is [`AuthorizationStatusError::NotFound`]
    /// for every caller, the same as an unknown id, so the read says nothing
    /// about whether `id` exists.
    ///
    /// # Errors
    ///
    /// See [`AuthorizationStatusError`].
    pub(crate) fn status(
        &self,
        id: &str,
        polling_sid: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<AuthorizationStatusView, AuthorizationStatusError> {
        let request = self
            .store
            .authorization_request_by_id(id)?
            .filter(|request| {
                polling_sid.is_some_and(|polling_sid| request.sid.as_deref() == Some(polling_sid))
            })
            .ok_or_else(|| AuthorizationStatusError::NotFound { id: id.to_owned() })?;
        if request.status == RequestStatus::Pending && request.expires_at < now {
            return Ok(AuthorizationStatusView::Expired);
        }
        Ok(match request.status {
            RequestStatus::Pending => AuthorizationStatusView::Pending,
            RequestStatus::Expired => AuthorizationStatusView::Expired,
            RequestStatus::Denied => AuthorizationStatusView::Denied {
                redirect_uri: request.redirect_uri,
                client_state: request.client_state,
            },
            RequestStatus::Approved => {
                let (Some(redirect_uri), Some(client_state)) =
                    (request.redirect_uri, request.client_state)
                else {
                    return Err(AuthorizationStatusError::ApprovedWithoutRedirect);
                };
                let code = self
                    .store
                    .authorization_code_by_request_id(id)?
                    .ok_or(AuthorizationStatusError::ApprovedWithoutCode)?;
                AuthorizationStatusView::Approved {
                    redirect_uri,
                    code: code.code,
                    client_state,
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use chrono::Duration;

    use super::*;
    use crate::domain::authorization_code::{IssuedAuthorizationCode, AUTHORIZATION_CODE_TTL};
    use crate::domain::test_fake::{code_request, device_request, FakeGrantStore};

    /// Each stored status maps to its view; a pending request past its TTL
    /// reads as expired; an unknown id is not found.
    #[test]
    fn status_reports_each_state_and_expires_stale_pending_requests() {
        let store = FakeGrantStore::default();
        let now = Utc::now();
        store
            .insert_authorization_request(&code_request(
                "pending",
                RequestStatus::Pending,
                now + Duration::minutes(5),
            ))
            .unwrap();
        store
            .insert_authorization_request(&code_request(
                "stale",
                RequestStatus::Pending,
                now - Duration::minutes(1),
            ))
            .unwrap();
        store
            .insert_authorization_request(&code_request(
                "denied",
                RequestStatus::Denied,
                now + Duration::minutes(5),
            ))
            .unwrap();
        store
            .insert_authorization_request(&code_request(
                "approved",
                RequestStatus::Approved,
                now + Duration::minutes(5),
            ))
            .unwrap();
        store
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
                sid: "sid-1".to_owned(),
            })
            .unwrap();
        let reader = AuthorizationStatusReader::new(store);

        assert_eq!(
            reader.status("pending", Some("sid-1"), now).unwrap(),
            AuthorizationStatusView::Pending
        );
        assert_eq!(
            reader.status("stale", Some("sid-1"), now).unwrap(),
            AuthorizationStatusView::Expired
        );
        assert!(matches!(
            reader.status("denied", Some("sid-1"), now).unwrap(),
            AuthorizationStatusView::Denied {
                redirect_uri: Some(_),
                client_state: Some(_),
            }
        ));
        assert_eq!(
            reader.status("approved", Some("sid-1"), now).unwrap(),
            AuthorizationStatusView::Approved {
                redirect_uri: Url::parse("https://example.com/cb").unwrap(),
                code: "the-code".to_owned(),
                client_state: "state".to_owned(),
            }
        );
        assert!(matches!(
            reader.status("ghost", Some("sid-1"), now),
            Err(AuthorizationStatusError::NotFound { .. })
        ));
    }

    /// Only the browser session a request was made in reads its status:
    /// another session, no session, and a request made in none (a device
    /// request) are all the same not-found as an unknown id.
    #[test]
    fn status_answers_only_the_session_the_request_was_made_in() {
        let store = FakeGrantStore::default();
        let now = Utc::now();
        store
            .insert_authorization_request(&code_request(
                "parked",
                RequestStatus::Pending,
                now + Duration::minutes(5),
            ))
            .unwrap();
        store
            .insert_authorization_request(&device_request("device", "CODE", RequestStatus::Pending))
            .unwrap();
        let reader = AuthorizationStatusReader::new(store);
        assert_eq!(
            reader.status("parked", Some("sid-1"), now).unwrap(),
            AuthorizationStatusView::Pending
        );
        for (id, polling_sid) in [
            ("parked", Some("another-sid")),
            ("parked", None),
            ("device", Some("sid-1")),
            ("device", None),
        ] {
            assert!(
                matches!(
                    reader.status(id, polling_sid, now),
                    Err(AuthorizationStatusError::NotFound { .. })
                ),
                "{id} polled from {polling_sid:?}"
            );
        }
    }
}
