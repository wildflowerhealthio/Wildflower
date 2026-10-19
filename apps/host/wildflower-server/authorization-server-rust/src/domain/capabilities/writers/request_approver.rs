//! [`RequestApprover`] — the writer that moves a pending authorization request
//! to `approved` and, for the code flow, issues the authorization code the
//! client redeems at `/oauth/token`. Every write demands a proof — the device
//! flow and a browser pairing a [`DelegatedScopes`], the code flow a
//! [`CodeAuthority`] (delegated scopes or standing-grant coverage) — so the
//! scopes recorded on the request are exactly the proof's, never a slice the
//! flow assembled, and a code carries the proof's scopes bounded by the
//! browser session the request was made in.

use chrono::{DateTime, Utc};

use wildflowerhealthio_scopes::Grant;

use crate::domain::authority::{session_bounded_scopes, DelegatedScopes, StandingGrantCoverage};
use crate::domain::authorization_code::{
    IssuedAuthorizationCode, PendingCodeRequest, AUTHORIZATION_CODE_TTL,
};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::{GrantStore, GrantTx};

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
    Issued(Box<IssuedAuthorizationCode>),
    /// The request was no longer pending (a concurrent decision or expiry
    /// won); nothing changed.
    RequestNotPending,
    /// The browser session the request was made in has ended — revoked,
    /// expired, or no longer stored — so it bounds no code: the request was
    /// denied instead, and no code issued.
    BrowserSessionEnded,
}

/// Approve pending requests. A borrowed view over the store; the gate is the
/// proof each method takes.
pub(crate) struct RequestApprover<'a, S: GrantStore> {
    store: &'a S,
}

impl<'a, S: GrantStore> RequestApprover<'a, S> {
    /// A writer over `store`.
    pub(crate) fn over(store: &'a S) -> Self {
        RequestApprover { store }
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
    /// The approval and the code land in one transaction, which first loads
    /// the request's browser session. A request whose session is no longer
    /// live at `now` (revoked, expired, or no longer stored) is denied rather
    /// than approved ([`CodeApproval::BrowserSessionEnded`]), so the client hears
    /// `access_denied` instead of redeeming a code whose tokens are refused on
    /// arrival. A request no longer pending issues nothing
    /// ([`CodeApproval::RequestNotPending`]); the flow maps that to its own
    /// not-found outcome.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn approve_for_code(
        &self,
        authority: CodeAuthority<'_>,
        pending_request: &PendingCodeRequest,
        patient: Option<&str>,
        code: String,
        now: DateTime<Utc>,
    ) -> Result<CodeApproval, AuthorizationServerError> {
        let authorized_scopes = authority.authorized_scopes();
        let request = pending_request.request();
        // One transaction, so an approved request never exists without its code,
        // and its session can't be revoked or narrowed between the read and the
        // approval.
        self.store.transaction(|tx| {
            let Some(browser_session) = tx
                .browser_session_by_sid(pending_request.sid())?
                .filter(|browser_session| browser_session.is_live(now))
            else {
                return Ok(if tx.deny_authorization_request(&request.id)? {
                    CodeApproval::BrowserSessionEnded
                } else {
                    CodeApproval::RequestNotPending
                });
            };
            if !tx.approve_authorization_request(&request.id, authorized_scopes, patient, None)? {
                return Ok(CodeApproval::RequestNotPending);
            }
            let authorization_code = IssuedAuthorizationCode {
                code,
                request_id: request.id.clone(),
                client_id: request.client_id.clone(),
                redirect_uri: pending_request.redirect_uri().clone(),
                code_challenge: pending_request.code_challenge().to_owned(),
                granted_scopes: session_bounded_scopes(
                    authorized_scopes,
                    &Grant::parse(&browser_session.scopes),
                ),
                patient: patient.map(str::to_owned),
                issued_at: now,
                expires_at: now + AUTHORIZATION_CODE_TTL,
                sid: browser_session.sid,
            };
            tx.issue_authorization_code(&authorization_code)?;
            Ok(CodeApproval::Issued(Box::new(authorization_code)))
        })
    }

    /// Approve the device-flow request `request_id` under `delegated_scopes`,
    /// binding the SMART-on-FHIR `patient` context (if any) and recording
    /// `device_name` (the approver's rename, else the device's own name; `None`
    /// leaves the request's name as is). Returns `false` when the request was no
    /// longer pending, in which case nothing changed.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn approve_for_device(
        &self,
        delegated_scopes: &DelegatedScopes,
        request_id: &str,
        patient: Option<&str>,
        device_name: Option<&str>,
    ) -> Result<bool, AuthorizationServerError> {
        self.store.approve_authorization_request(
            request_id,
            delegated_scopes.scopes(),
            patient,
            device_name,
        )
    }

    /// Approve the browser pairing request `request_id` under
    /// `delegated_scopes`, recording `browser_name` (the approver's rename,
    /// else the browser's own name). The approved session is started later,
    /// when the pairing page's poll claims the request. Returns `false` when
    /// the request was no longer pending, in which case nothing changed.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn approve_browser_pairing(
        &self,
        delegated_scopes: &DelegatedScopes,
        request_id: &str,
        browser_name: &str,
    ) -> Result<bool, AuthorizationServerError> {
        self.store.approve_authorization_request(
            request_id,
            delegated_scopes.scopes(),
            None,
            Some(browser_name),
        )
    }
}

#[cfg(test)]
mod tests {

    use chrono::Duration;

    use super::*;
    use crate::domain::authorization_request::{AuthorizationRequest, RequestStatus};
    use crate::domain::browser_session::BrowserSession;
    use crate::domain::test_fake::{
        code_request, delegated_scopes, device_request, owned_scopes, FakeGrantStore,
    };

    /// The fixture code request `id`, in `status`, as the approver takes it,
    /// made in an Owner session that stands.
    fn pending_request(
        store: &FakeGrantStore,
        id: &str,
        status: RequestStatus,
    ) -> PendingCodeRequest {
        let standing =
            BrowserSession::new_owner(crate::owner_scopes(), Duration::hours(8), Utc::now());
        store.insert_browser_session(&standing).unwrap();
        pending_request_in_session(store, id, status, &standing.sid)
    }

    /// [`pending_request`], made in the browser session `sid`.
    fn pending_request_in_session(
        store: &FakeGrantStore,
        id: &str,
        status: RequestStatus,
        sid: &str,
    ) -> PendingCodeRequest {
        let request = AuthorizationRequest {
            sid: Some(sid.to_owned()),
            ..code_request(id, status, Utc::now() + Duration::minutes(5))
        };
        store.insert_authorization_request(&request).unwrap();
        PendingCodeRequest::from_request(request).expect("a code request")
    }

    /// Approve `pending_request` on the Owner's authority, issuing `the-code`.
    fn approve(store: &FakeGrantStore, pending_request: &PendingCodeRequest) -> CodeApproval {
        RequestApprover::over(store)
            .approve_for_code(
                CodeAuthority::OwnerDelegated(&delegated_scopes(&["patient/Patient.r"])),
                pending_request,
                None,
                "the-code".to_owned(),
                Utc::now(),
            )
            .unwrap()
    }

    /// The code flow: the request flips to approved carrying the proof's scopes,
    /// and the issued_code code is bound to the request's client, redirect, and
    /// challenge with the same scopes.
    #[test]
    fn approve_for_code_records_the_proofs_scopes_on_request_and_code() {
        let store = FakeGrantStore::default();
        let pending_request = pending_request(&store, "req-1", RequestStatus::Pending);
        let now = Utc::now();
        let CodeApproval::Issued(issued_code) = RequestApprover::over(&store)
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
        assert_eq!(issued_code.granted_scopes, ["patient/Patient.r"]);
        assert_eq!(issued_code.expires_at, now + AUTHORIZATION_CODE_TTL);
        assert_eq!(issued_code.code_challenge, pending_request.code_challenge());
        let request = store
            .authorization_request_by_id("req-1")
            .unwrap()
            .expect("present");
        assert_eq!(request.status, RequestStatus::Approved);
        assert_eq!(
            request.granted_scopes.as_deref(),
            Some(&["patient/Patient.r".to_owned()][..])
        );
        let stored = store
            .authorization_code_by_request_id("req-1")
            .unwrap()
            .expect("code issued_code");
        assert_eq!(stored.code, "the-code");
        assert_eq!(stored.patient.as_deref(), Some("pat-1"));
    }

    /// A request that is no longer pending issues nothing — the outcome the
    /// flow maps to not-found — and leaves no code behind.
    #[test]
    fn approve_for_code_issues_nothing_when_the_request_is_not_pending() {
        let store = FakeGrantStore::default();
        let pending_request = pending_request(&store, "req-1", RequestStatus::Denied);
        assert_eq!(
            approve(&store, &pending_request),
            CodeApproval::RequestNotPending
        );
        assert_eq!(
            store.authorization_code_by_request_id("req-1").unwrap(),
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
        let standing = BrowserSession::new_owner(vec![], Duration::hours(8), now);
        let revoked = BrowserSession::new_owner(vec![], Duration::hours(8), now);
        let expired =
            BrowserSession::new_owner(vec![], Duration::hours(8), now - Duration::hours(9));
        for session in [&standing, &revoked, &expired] {
            store.insert_browser_session(session).unwrap();
        }
        assert!(store.revoke_browser_session(&revoked.sid, now).unwrap());

        for (id, sid) in [
            ("req-revoked", revoked.sid.as_str()),
            ("req-expired", expired.sid.as_str()),
            ("req-missing", "no-such-sid"),
        ] {
            let pending_request =
                pending_request_in_session(&store, id, RequestStatus::Pending, sid);
            assert_eq!(
                approve(&store, &pending_request),
                CodeApproval::BrowserSessionEnded,
                "{id}"
            );
            let request = store
                .authorization_request_by_id(id)
                .unwrap()
                .expect("present");
            assert_eq!(request.status, RequestStatus::Denied, "{id}");
            assert_eq!(
                store.authorization_code_by_request_id(id).unwrap(),
                None,
                "{id}"
            );
        }

        let pending_request = pending_request_in_session(
            &store,
            "req-standing",
            RequestStatus::Pending,
            &standing.sid,
        );
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
        let paired = BrowserSession::new_approved(
            "Firefox on Linux".to_owned(),
            vec![
                "wildflower/launch".to_owned(),
                "patient/Patient.rs".to_owned(),
            ],
            Duration::hours(24),
            Utc::now(),
        );
        store.insert_browser_session(&paired).unwrap();
        let pending_request =
            pending_request_in_session(&store, "req-1", RequestStatus::Pending, &paired.sid);
        let approved = ["openid", "patient/Patient.read", "patient/Observation.rs"];
        let CodeApproval::Issued(issued_code) = RequestApprover::over(&store)
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
        let request = store
            .authorization_request_by_id("req-1")
            .unwrap()
            .expect("present");
        assert_eq!(
            request.granted_scopes.as_deref(),
            Some(&owned_scopes(&approved)[..])
        );
    }

    /// The device flow: the request flips to approved carrying the proof's
    /// scopes and the recorded device name; a non-pending request reports
    /// `false`.
    #[test]
    fn approve_for_device_records_scopes_and_name_only_while_pending() {
        let store = FakeGrantStore::default();
        store
            .insert_authorization_request(&device_request("dev-1", "CODE", RequestStatus::Pending))
            .unwrap();
        let approver = RequestApprover::over(&store);
        let scopes = delegated_scopes(&["patient/Patient.r"]);
        let approved = approver
            .approve_for_device(&scopes, "dev-1", None, Some("Kitchen iPad"))
            .unwrap();
        assert!(approved);
        let request = store
            .authorization_request_by_id("dev-1")
            .unwrap()
            .expect("present");
        assert_eq!(request.status, RequestStatus::Approved);
        assert_eq!(request.device_name.as_deref(), Some("Kitchen iPad"));

        let again = approver
            .approve_for_device(&scopes, "dev-1", None, None)
            .unwrap();
        assert!(!again, "an already-approved request is not approved twice");
    }
}
