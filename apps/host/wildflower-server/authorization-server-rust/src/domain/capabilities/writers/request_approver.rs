//! [`RequestApprover`] — the writer that moves a pending authorization request
//! to `approved` (the request's own transition for its kind —
//! [`approve_code`](AuthorizationRequest::approve_code),
//! [`approve_device`](AuthorizationRequest::approve_device) or
//! [`approve_pairing`](AuthorizationRequest::approve_pairing) — written with
//! the guarded replace) and, for the code flow, issues the authorization code the
//! client redeems at `/oauth/token`. Every write demands a proof — the device
//! flow and a browser pairing a [`DelegatedScopes`], the code flow a
//! [`CodeAuthority`] (delegated scopes or standing-grant coverage) — so the
//! scopes recorded on the request are exactly the proof's, never a slice the
//! flow assembled, and a code carries the proof's scopes bounded by the
//! browser session the request was made in.

use chrono::{DateTime, Utc};

use wildflowerhealthio_scopes::Grant;

use crate::domain::authority::{session_bounded_scopes, DelegatedScopes, StandingGrantCoverage};
use crate::domain::authorization_code::{AuthorizationCode, AUTHORIZATION_CODE_TTL};
use crate::domain::authorization_request::{Approval, AuthorizationRequest, PendingCodeRequest};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::grant_store::write_transition;
use crate::domain::GrantTx;

/// On whose authority a code-flow request is approved — the two proofs that
/// may issue an authorization code. Listing them here is the point: a reader
/// auditing "who can issue a code with no human?" finds
/// [`StandingGrant`](Self::StandingGrant) by name — an enum, not a trait, for
/// the reason in the [`authority` module docs](crate::domain::authority).
pub(crate) enum CodeAuthority<'a> {
    /// The Owner approved the prompt.
    OwnerDelegated(&'a DelegatedScopes),
    /// A standing grant already covered every requested scope.
    StandingGrant(&'a StandingGrantCoverage),
}

impl CodeAuthority<'_> {
    /// The scopes this authority lets a code carry.
    fn authorized_scopes(&self) -> &[String] {
        match self {
            CodeAuthority::OwnerDelegated(delegated) => delegated.scopes(),
            CodeAuthority::StandingGrant(standing_grant_coverage) => {
                standing_grant_coverage.covered_scopes()
            }
        }
    }
}

/// What [`RequestApprover::approve_for_code`] did with a pending code-flow
/// request.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CodeApproval {
    /// The request was approved and this code issued for it.
    Issued(Box<AuthorizationCode>),
    /// The request was no longer pending (a concurrent decision or expiry
    /// won); nothing changed.
    RequestNotPending,
    /// The browser session the request was made in has ended — revoked,
    /// expired, or no longer stored — so it bounds no code: the request was
    /// denied instead, and no code issued.
    BrowserSessionEnded,
}

/// Approve pending requests, inside the caller's transaction; the gate is the
/// proof each method takes.
pub(crate) struct RequestApprover<'a, T: GrantTx> {
    tx: &'a mut T,
}

impl<'a, T: GrantTx> RequestApprover<'a, T> {
    /// A writer inside the caller's transaction `tx`.
    pub(crate) fn within(tx: &'a mut T) -> Self {
        RequestApprover { tx }
    }

    /// Approve the pending code-flow request under `authority` and issue
    /// `code` for it, bound to the request's client, redirect, and PKCE
    /// challenge, to the browser session the request was made in (not the
    /// approver's, so revoking the browser the app runs in ends it), and
    /// to the SMART-on-FHIR `patient` context (if any), expiring
    /// [`AUTHORIZATION_CODE_TTL`] after `now`. The flow generates `code` (a
    /// CSPRNG opaque token) so tests can inject a known value.
    ///
    /// The request records the authority's scopes; the code carries only
    /// those the request's browser session also allows
    /// ([`session_bounded_scopes`]), so a browser paired with less than the
    /// Owner holds earns no app more than it holds, whoever approved.
    ///
    /// The approval and the code land in the caller's transaction, which
    /// first loads the request's browser session. A request whose session is no longer
    /// live at `now` (revoked, expired, or no longer stored) is denied rather
    /// than approved ([`CodeApproval::BrowserSessionEnded`]), so the client
    /// hears `access_denied` rather than earning a code no live session
    /// bounds. A request no longer pending issues nothing
    /// ([`CodeApproval::RequestNotPending`]); the flow maps that to its own
    /// not-found outcome.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn approve_for_code(
        &mut self,
        authority: CodeAuthority<'_>,
        pending_request: &PendingCodeRequest,
        patient: Option<&str>,
        code: String,
        now: DateTime<Utc>,
    ) -> Result<CodeApproval, AuthorizationServerError> {
        let authorized_scopes = authority.authorized_scopes();
        let request = pending_request.request();
        let code_request = pending_request.code();
        let Some(browser_session) = self
            .tx
            .browser_session_by_sid(&code_request.sid)?
            .filter(|browser_session| browser_session.is_live(now))
        else {
            return Ok(if write_transition(self.tx, request.deny(now))? {
                CodeApproval::BrowserSessionEnded
            } else {
                CodeApproval::RequestNotPending
            });
        };
        let approval = Approval {
            granted_scopes: authorized_scopes.to_vec(),
            patient: patient.map(str::to_owned),
        };
        if !write_transition(self.tx, request.approve_code(approval, now))? {
            return Ok(CodeApproval::RequestNotPending);
        }
        let authorization_code = AuthorizationCode {
            code,
            request_id: request.id().to_owned(),
            client_id: request.client_id().to_owned(),
            redirect_uri: code_request.redirect_uri.clone(),
            code_challenge: code_request.code_challenge.clone(),
            granted_scopes: session_bounded_scopes(
                authorized_scopes,
                &Grant::parse(&browser_session.scopes),
            ),
            patient: patient.map(str::to_owned),
            issued_at: now,
            expires_at: now + AUTHORIZATION_CODE_TTL,
            sid: browser_session.sid,
        };
        self.tx.issue_authorization_code(&authorization_code)?;
        Ok(CodeApproval::Issued(Box::new(authorization_code)))
    }

    /// Approve the device request `device_request`, as read, under
    /// `delegated_scopes` at `now`, binding the SMART-on-FHIR `patient` context
    /// (if any) and recording `device_name` (the approver's rename; `None`
    /// keeps the device's own name). Returns `false` when the request was no
    /// longer pending, in which case nothing changed.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn approve_for_device(
        &mut self,
        delegated_scopes: &DelegatedScopes,
        device_request: &AuthorizationRequest,
        patient: Option<&str>,
        device_name: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<bool, AuthorizationServerError> {
        let approval = Approval {
            granted_scopes: delegated_scopes.scopes().to_vec(),
            patient: patient.map(str::to_owned),
        };
        write_transition(
            self.tx,
            device_request.approve_device(approval, device_name.map(str::to_owned), now),
        )
    }

    /// Approve the browser pairing `pairing_request`, as read, under
    /// `delegated_scopes` at `now`, recording `browser_name` (the approver's
    /// rename; `None` keeps the browser's own name). The paired session is
    /// started later, when the pairing page's poll claims the request.
    /// Returns `false` when the request was no longer pending, in which case
    /// nothing changed.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn approve_browser_pairing(
        &mut self,
        delegated_scopes: &DelegatedScopes,
        pairing_request: &AuthorizationRequest,
        browser_name: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<bool, AuthorizationServerError> {
        let approval = Approval {
            granted_scopes: delegated_scopes.scopes().to_vec(),
            patient: None,
        };
        write_transition(
            self.tx,
            pairing_request.approve_pairing(approval, browser_name.map(str::to_owned), now),
        )
    }
}

#[cfg(test)]
mod tests {
    use chrono::Duration;

    use super::*;
    use crate::domain::authorization_request::{CodeRequest, RequestKind, RequestStatus};
    use crate::domain::browser_session::BrowserSession;
    use crate::domain::grant_store::*;
    use crate::domain::test_fake::{
        delegated_scopes, device_request, fixture_code, owned_scopes, pending_request,
        FakeGrantStore,
    };

    /// A pending code request `id`, as the approver takes it, made in a
    /// same-device session that stands.
    fn pending_code_request(store: &FakeGrantStore, id: &str) -> PendingCodeRequest {
        let standing = BrowserSession::new_same_device_session(
            crate::owner_scopes(),
            Duration::hours(8),
            Utc::now(),
        );
        store.tx().insert_browser_session(&standing).unwrap();
        pending_code_request_in_session(store, id, &standing.sid)
    }

    /// [`pending_code_request`], made in the browser session `sid`.
    fn pending_code_request_in_session(
        store: &FakeGrantStore,
        id: &str,
        sid: &str,
    ) -> PendingCodeRequest {
        let request = pending_request(
            id,
            &["read"],
            Utc::now() + Duration::minutes(5),
            RequestKind::AuthorizationCode(CodeRequest {
                sid: sid.to_owned(),
                ..fixture_code()
            }),
        );
        store.tx().insert_authorization_request(&request).unwrap();
        request
            .into_pending_code(Utc::now())
            .expect("a pending code request")
    }

    fn stored(store: &FakeGrantStore, id: &str) -> AuthorizationRequest {
        store
            .tx()
            .authorization_request_by_id(id)
            .unwrap()
            .expect("present")
    }

    /// Approve `pending_request` on the Owner's authority, issuing `the-code`.
    fn approve(store: &FakeGrantStore, pending_request: &PendingCodeRequest) -> CodeApproval {
        RequestApprover::within(&mut store.tx())
            .approve_for_code(
                CodeAuthority::OwnerDelegated(&delegated_scopes(&["patient/Patient.r"])),
                pending_request,
                None,
                "the-code".to_owned(),
                Utc::now(),
            )
            .unwrap()
    }

    /// The code flow: the request is approved with the proof's scopes and the
    /// patient, and the issued code is bound to the request's client,
    /// redirect, and challenge with the same scopes.
    #[test]
    fn approve_for_code_records_the_proofs_scopes_on_request_and_code() {
        let store = FakeGrantStore::default();
        let pending_request = pending_code_request(&store, "req-1");
        let now = Utc::now();
        let CodeApproval::Issued(issued_code) = RequestApprover::within(&mut store.tx())
            .approve_for_code(
                CodeAuthority::OwnerDelegated(&delegated_scopes(&["patient/Patient.r"])),
                &pending_request,
                Some("pat-1"),
                "the-code".to_owned(),
                now,
            )
            .unwrap()
        else {
            panic!("request was pending");
        };
        assert_eq!(
            *issued_code,
            AuthorizationCode {
                code: "the-code".to_owned(),
                request_id: "req-1".to_owned(),
                client_id: "client".to_owned(),
                redirect_uri: pending_request.code().redirect_uri.clone(),
                code_challenge: pending_request.code().code_challenge.clone(),
                granted_scopes: owned_scopes(&["patient/Patient.r"]),
                patient: Some("pat-1".to_owned()),
                issued_at: now,
                expires_at: now + AUTHORIZATION_CODE_TTL,
                sid: pending_request.code().sid.clone(),
            }
        );
        let request = stored(&store, "req-1");
        assert_eq!(request.status(), RequestStatus::Approved);
        assert_eq!(
            request.approval(),
            Some(&Approval {
                granted_scopes: owned_scopes(&["patient/Patient.r"]),
                patient: Some("pat-1".to_owned()),
            })
        );
        assert_eq!(
            store
                .tx()
                .authorization_code_by_request_id("req-1")
                .unwrap(),
            Some(*issued_code)
        );
    }

    /// A request decided since it was read issues nothing — the outcome the
    /// flow maps to not-found — and leaves no code behind.
    #[test]
    fn approve_for_code_issues_nothing_when_the_request_is_no_longer_pending() {
        let store = FakeGrantStore::default();
        let pending_request = pending_code_request(&store, "req-1");
        let denied = pending_request.request().deny(Utc::now()).unwrap();
        assert!(store.tx().replace_authorization_request(&denied).unwrap());
        assert_eq!(
            approve(&store, &pending_request),
            CodeApproval::RequestNotPending
        );
        assert_eq!(
            store
                .tx()
                .authorization_code_by_request_id("req-1")
                .unwrap(),
            None
        );
    }

    /// A request made in a browser session that has since been revoked, that
    /// has expired without being revoked, or that names no session, is denied
    /// and earns no code; one whose session stands is approved.
    #[test]
    fn approve_for_code_denies_a_request_whose_browser_session_has_ended() {
        let store = FakeGrantStore::default();
        let now = Utc::now();
        let standing = BrowserSession::new_same_device_session(vec![], Duration::hours(8), now);
        let revoked = BrowserSession::new_same_device_session(vec![], Duration::hours(8), now);
        let expired = BrowserSession::new_same_device_session(
            vec![],
            Duration::hours(8),
            now - Duration::hours(9),
        );
        for session in [&standing, &revoked, &expired] {
            store.tx().insert_browser_session(session).unwrap();
        }
        assert!(store
            .tx()
            .revoke_browser_session(&revoked.sid, now)
            .unwrap());

        for (id, sid) in [
            ("req-revoked", revoked.sid.as_str()),
            ("req-expired", expired.sid.as_str()),
            ("req-missing", "no-such-sid"),
        ] {
            let pending_request = pending_code_request_in_session(&store, id, sid);
            assert_eq!(
                approve(&store, &pending_request),
                CodeApproval::BrowserSessionEnded,
                "{id}"
            );
            assert_eq!(stored(&store, id).status(), RequestStatus::Denied, "{id}");
            assert_eq!(
                store.tx().authorization_code_by_request_id(id).unwrap(),
                None,
                "{id}"
            );
        }

        let pending_request =
            pending_code_request_in_session(&store, "req-standing", &standing.sid);
        assert!(matches!(
            approve(&store, &pending_request),
            CodeApproval::Issued(issued_code) if issued_code.sid == standing.sid
        ));
    }

    /// A code carries only what the request's browser session also allows,
    /// whoever approved; the request records the approval as made.
    #[test]
    fn approve_for_code_bounds_the_code_by_the_request_s_browser_session() {
        let store = FakeGrantStore::default();
        let paired = BrowserSession::new_paired_session(
            "Firefox on Linux".to_owned(),
            vec![
                "wildflower/launch".to_owned(),
                "patient/Patient.rs".to_owned(),
            ],
            Duration::hours(24),
            Utc::now(),
        );
        store.tx().insert_browser_session(&paired).unwrap();
        let pending_request = pending_code_request_in_session(&store, "req-1", &paired.sid);
        let approved = ["openid", "patient/Patient.read", "patient/Observation.rs"];
        let CodeApproval::Issued(issued_code) = RequestApprover::within(&mut store.tx())
            .approve_for_code(
                CodeAuthority::OwnerDelegated(&delegated_scopes(&approved)),
                &pending_request,
                None,
                "the-code".to_owned(),
                Utc::now(),
            )
            .unwrap()
        else {
            panic!("request was pending");
        };
        assert_eq!(
            issued_code.granted_scopes,
            ["openid", "patient/Patient.read"]
        );
        assert_eq!(
            stored(&store, "req-1").approval(),
            Some(&Approval {
                granted_scopes: owned_scopes(&approved),
                patient: None,
            })
        );
    }

    /// The device flow: the request is approved carrying the proof's scopes
    /// and the recorded device name; approving the same read again lands
    /// nowhere.
    #[test]
    fn approve_for_device_records_scopes_and_name_only_while_pending() {
        let store = FakeGrantStore::default();
        let read = device_request("dev-1", "CODE", RequestStatus::Pending);
        store.tx().insert_authorization_request(&read).unwrap();
        let mut tx = store.tx();
        let mut approver = RequestApprover::within(&mut tx);
        let scopes = delegated_scopes(&["patient/Patient.r"]);
        let now = Utc::now();
        assert!(approver
            .approve_for_device(&scopes, &read, None, Some("Kitchen iPad"), now)
            .unwrap());
        let request = stored(&store, "dev-1");
        assert_eq!(request.status(), RequestStatus::Approved);
        assert_eq!(
            request
                .device()
                .and_then(|device| device.device_name.as_deref()),
            Some("Kitchen iPad")
        );
        assert!(
            !approver
                .approve_for_device(&scopes, &read, None, None, now)
                .unwrap(),
            "an already-approved request is not approved twice"
        );
    }
}
