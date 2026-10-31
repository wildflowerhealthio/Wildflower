//! [`RequestApprover`] — the writer that moves a pending authorization request
//! to approved (the flow's own `approve` transition —
//! [`CodeRequest::approve`], [`DeviceRequest::approve`],
//! [`PairingRequest::approve`] or [`SessionWideningRequest::approve`] —
//! written with the flow's guarded replace) and, for the code flow, issues
//! the authorization code the client redeems at `/oauth/token`, and for a
//! session widening, widens the browser session. Every write demands a proof
//! — the device flow, a browser pairing and a session widening a
//! [`DelegatedScopes`], the code flow a [`CodeAuthority`] (delegated scopes
//! or standing-grant coverage) — so the scopes recorded on the request are
//! exactly the proof's, never a slice the flow assembled, and a code carries
//! the proof's scopes bounded by the browser session the request was made in.

use chrono::{DateTime, Utc};

use wildflowerhealthio_scopes::Grant;

use crate::domain::authority::{session_bounded_scopes, DelegatedScopes, StandingGrantCoverage};
use crate::domain::authorization_code::{AuthorizationCode, AUTHORIZATION_CODE_TTL};
use crate::domain::authorization_request::approval::Approval;
use crate::domain::authorization_request::code::CodeRequest;
use crate::domain::authorization_request::device::DeviceRequest;
use crate::domain::authorization_request::pairing::{PairingApproval, PairingRequest};
use crate::domain::authorization_request::session_widening::{
    SessionWideningApproval, SessionWideningRequest,
};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::browser_session::{BrowserSession, StaleSessionCutoff};
use crate::domain::GrantTx;

/// On whose authority a code-flow request is approved — the two proofs that
/// may issue an authorization code. Listing them here is the point: a reader
/// auditing "who can issue a code with no human?" finds
/// [`StandingGrant`](Self::StandingGrant) by name — an enum, not a trait, for
/// the reason in the [`authority` module docs](crate::domain::authority).
pub(crate) enum CodeAuthority<'a> {
    /// An approver (the Owner, or a browser the Owner paired) approved the
    /// prompt, delegating these scopes.
    OwnerDelegated(&'a DelegatedScopes),
    /// A standing grant already covered every requested scope, so the code is
    /// issued with nobody asked, and the grant is stamped used.
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
    /// expired, stale, or no longer stored — so it bounds no code: the
    /// request was denied instead, and no code issued.
    BrowserSessionEnded,
}

/// What [`RequestApprover::approve_session_widening`] did with a pending
/// session widening.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SessionWideningOutcome {
    /// The widening was approved, and its browser session widened.
    Widened,
    /// The widening was no longer pending (a concurrent decision or expiry
    /// won); nothing changed.
    RequestNotPending,
    /// The browser session the widening was asked in has ended — revoked,
    /// expired, or no longer stored — so there is nothing to widen: the
    /// widening was denied instead.
    BrowserSessionEnded,
}

/// What [`RequestApprover::live_session_or_deny`] found of a request's
/// browser session.
enum RequestSession {
    /// The session is live: the request may be approved under it.
    Live(BrowserSession),
    /// The session has ended, and the request was denied.
    EndedAndDenied,
    /// The session has ended, and the request was no longer pending to deny.
    RequestNotPending,
}

/// Approve pending requests of every flow and, for the code flow, issue the
/// request's authorization code, and for a session widening, widen its
/// session, inside the caller's transaction. The gate is the proof each method
/// takes: a [`DelegatedScopes`] for a device request, a browser pairing or a
/// session widening, a [`CodeAuthority`] (delegated scopes or a
/// [`StandingGrantCoverage`]) for a code.
pub(crate) struct RequestApprover<'a, T: GrantTx> {
    /// The caller's open write scope; the approval and the code land with the
    /// rest of the operation or not at all.
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
    /// Under a [`CodeAuthority::StandingGrant`], issuing the code also stamps
    /// that grant's `last_used_at` with `now`: the grant just stood in for the
    /// Owner.
    ///
    /// The approval and the code land in the caller's transaction, which
    /// first loads the request's browser session. A request whose session is
    /// no longer live at `now` under `stale_session_cutoff` (revoked, expired,
    /// stale, or no longer stored) is denied rather than approved
    /// ([`CodeApproval::BrowserSessionEnded`]), so the client hears
    /// `access_denied` rather than earning a code no live session bounds. A
    /// request no longer pending issues nothing
    /// ([`CodeApproval::RequestNotPending`]); the flow maps that to its own
    /// not-found outcome.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn approve_for_code(
        &mut self,
        authority: CodeAuthority<'_>,
        request: &CodeRequest,
        patient: Option<&str>,
        code: String,
        stale_session_cutoff: &StaleSessionCutoff,
        now: DateTime<Utc>,
    ) -> Result<CodeApproval, AuthorizationServerError> {
        let authorized_scopes = authority.authorized_scopes();
        let browser_session =
            match self.live_session_or_deny(&request.sid, stale_session_cutoff, now, |tx| {
                match request.deny(now) {
                    Ok(denied) => tx.replace_code_request(request, &denied),
                    Err(_) => Ok(false),
                }
            })? {
                RequestSession::Live(browser_session) => browser_session,
                RequestSession::EndedAndDenied => return Ok(CodeApproval::BrowserSessionEnded),
                RequestSession::RequestNotPending => return Ok(CodeApproval::RequestNotPending),
            };
        let approval = Approval {
            granted_scopes: authorized_scopes.to_vec(),
            patient: patient.map(str::to_owned),
        };
        let Ok(approved) = request.approve(approval, now) else {
            return Ok(CodeApproval::RequestNotPending);
        };
        if !self.tx.replace_code_request(request, &approved)? {
            return Ok(CodeApproval::RequestNotPending);
        }
        let authorization_code = AuthorizationCode {
            code,
            request_id: request.id.clone(),
            client_id: request.client_id.clone(),
            redirect_uri: request.redirect_uri.clone(),
            code_challenge: request.code_challenge.clone(),
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
        if let CodeAuthority::StandingGrant(standing_grant_coverage) = authority {
            self.tx
                .stamp_authorization_code_grant_used(standing_grant_coverage.grant_id(), now)?;
        }
        Ok(CodeApproval::Issued(Box::new(authorization_code)))
    }

    /// Approve the device request `request`, as read, under
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
        request: &DeviceRequest,
        patient: Option<&str>,
        device_name: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<bool, AuthorizationServerError> {
        let approval = Approval {
            granted_scopes: delegated_scopes.scopes().to_vec(),
            patient: patient.map(str::to_owned),
        };
        match request.approve(approval, device_name.map(str::to_owned), now) {
            Ok(approved) => self.tx.replace_device_request(request, &approved),
            Err(_) => Ok(false),
        }
    }

    /// Approve the browser pairing `request`, as read, under
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
        request: &PairingRequest,
        browser_name: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<bool, AuthorizationServerError> {
        let approval = PairingApproval {
            granted_scopes: delegated_scopes.scopes().to_vec(),
        };
        match request.approve(approval, browser_name.map(str::to_owned), now) {
            Ok(approved) => self.tx.replace_pairing_request(request, &approved),
            Err(_) => Ok(false),
        }
    }

    /// Approve the session widening `request`, as read, under
    /// `delegated_scopes` at `now`, and widen the browser session it was
    /// asked in by them: the session's scopes grow by what the Owner granted
    /// ([`widened_scopes`](wildflowerhealthio_scopes::widened_scopes), so
    /// they never shrink), and its `sid`, expiry and everything minted under
    /// it stay as they are. Every client the session went on past its limited
    /// page for is forgotten, so its next sign-in carries the wider session,
    /// or stops at the page again for what it still lacks.
    ///
    /// A widening whose session is no longer live at `now` under
    /// `stale_session_cutoff` is denied rather than approved
    /// ([`SessionWideningOutcome::BrowserSessionEnded`]).
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn approve_session_widening(
        &mut self,
        delegated_scopes: &DelegatedScopes,
        request: &SessionWideningRequest,
        stale_session_cutoff: &StaleSessionCutoff,
        now: DateTime<Utc>,
    ) -> Result<SessionWideningOutcome, AuthorizationServerError> {
        let browser_session =
            match self.live_session_or_deny(&request.sid, stale_session_cutoff, now, |tx| {
                match request.deny(now) {
                    Ok(denied) => tx.replace_session_widening_request(request, &denied),
                    Err(_) => Ok(false),
                }
            })? {
                RequestSession::Live(browser_session) => browser_session,
                RequestSession::EndedAndDenied => {
                    return Ok(SessionWideningOutcome::BrowserSessionEnded)
                }
                RequestSession::RequestNotPending => {
                    return Ok(SessionWideningOutcome::RequestNotPending)
                }
            };
        let approval = SessionWideningApproval {
            granted_scopes: delegated_scopes.scopes().to_vec(),
        };
        let Ok(approved) = request.approve(approval, now) else {
            return Ok(SessionWideningOutcome::RequestNotPending);
        };
        if !self
            .tx
            .replace_session_widening_request(request, &approved)?
        {
            return Ok(SessionWideningOutcome::RequestNotPending);
        }
        let widened_session_scopes = wildflowerhealthio_scopes::widened_scopes(
            &browser_session.scopes,
            delegated_scopes.scopes(),
        );
        if !self
            .tx
            .update_browser_session_scopes(&browser_session.sid, &widened_session_scopes)?
        {
            // The row was read live in this same scope, so a miss is the
            // store breaking its word: fail, rolling the approval back.
            return Err(AuthorizationServerError::Infrastructure {
                context: "approve_session_widening: the live session's row wasn't updated",
                source: format!("no browser session {}", browser_session.sid),
            });
        }
        self.tx
            .forget_session_shortfall_acknowledgements(&browser_session.sid)?;
        Ok(SessionWideningOutcome::Widened)
    }

    /// The browser session `sid` a pending request was made in, when it is
    /// live at `now` under `stale_session_cutoff`. Otherwise the request is
    /// denied with `deny_request` — the flow's deny transition and guarded
    /// replace, `true` when the denial landed — so no approval outlives the
    /// session it was for.
    fn live_session_or_deny(
        &mut self,
        sid: &str,
        stale_session_cutoff: &StaleSessionCutoff,
        now: DateTime<Utc>,
        deny_request: impl FnOnce(&mut T) -> Result<bool, AuthorizationServerError>,
    ) -> Result<RequestSession, AuthorizationServerError> {
        if let Some(browser_session) = self
            .tx
            .browser_session_by_sid(sid)?
            .filter(|browser_session| browser_session.is_live_at(now, stale_session_cutoff))
        {
            return Ok(RequestSession::Live(browser_session));
        }
        Ok(if deny_request(self.tx)? {
            RequestSession::EndedAndDenied
        } else {
            RequestSession::RequestNotPending
        })
    }
}

#[cfg(test)]
mod tests {
    use chrono::Duration;
    use std::collections::HashSet;

    use super::*;
    use crate::domain::authority::GrantCoverage;
    use crate::domain::authorization_request::code::{CodeRequestState, NewCodeRequestArgs};
    use crate::domain::authorization_request::polled::PolledState;
    use crate::domain::authorization_request::{AuthorizationRequest, RequestStatus};
    use crate::domain::browser_session::BrowserSession;
    use crate::domain::client::presented_change::PresentedClientChange;
    use crate::domain::grant_store::*;
    use crate::domain::test_fake::{
        code_grant, delegated_scopes, device_request, fixture_code_args, owned_scopes,
        FakeGrantStore,
    };

    /// A pending code request `id`, as the approver takes it, made in a
    /// same-device session that stands.
    fn pending_code_request(store: &FakeGrantStore, id: &str) -> CodeRequest {
        let standing = BrowserSession::new_same_device_session(
            crate::owner_scopes(),
            Duration::hours(8),
            Utc::now(),
        );
        store.tx().insert_browser_session(&standing).unwrap();
        pending_code_request_in_session(store, id, &standing.sid)
    }

    /// [`pending_code_request`], made in the browser session `sid`.
    fn pending_code_request_in_session(store: &FakeGrantStore, id: &str, sid: &str) -> CodeRequest {
        let request = CodeRequest::new(
            NewCodeRequestArgs {
                sid: sid.to_owned(),
                ..fixture_code_args(id, "client", owned_scopes(&["read"]))
            },
            Utc::now(),
        );
        store.tx().insert_code_request(&request).unwrap();
        request
    }

    /// The authorization request `id` as the store holds it now.
    fn stored(store: &FakeGrantStore, id: &str) -> AuthorizationRequest {
        store
            .tx()
            .authorization_request_by_id(id)
            .unwrap()
            .expect("present")
    }

    /// Approve `pending_request` on the Owner's authority, issuing `the-code`,
    /// under a cutoff before any session.
    fn approve(store: &FakeGrantStore, pending_request: &CodeRequest) -> CodeApproval {
        approve_under(store, pending_request, &StaleSessionCutoff::none())
    }

    /// Approve `pending_request` on the Owner's authority, issuing `the-code`,
    /// under `stale_session_cutoff`.
    fn approve_under(
        store: &FakeGrantStore,
        pending_request: &CodeRequest,
        stale_session_cutoff: &StaleSessionCutoff,
    ) -> CodeApproval {
        RequestApprover::within(&mut store.tx())
            .approve_for_code(
                CodeAuthority::OwnerDelegated(&delegated_scopes(&["patient/Patient.r"])),
                pending_request,
                None,
                "the-code".to_owned(),
                stale_session_cutoff,
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
                &StaleSessionCutoff::none(),
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
                redirect_uri: pending_request.redirect_uri.clone(),
                code_challenge: pending_request.code_challenge.clone(),
                granted_scopes: owned_scopes(&["patient/Patient.r"]),
                patient: Some("pat-1".to_owned()),
                issued_at: now,
                expires_at: now + AUTHORIZATION_CODE_TTL,
                sid: pending_request.sid.clone(),
            }
        );
        assert_eq!(
            stored(&store, "req-1"),
            AuthorizationRequest::Code(CodeRequest {
                state: CodeRequestState::Approved(Approval {
                    granted_scopes: owned_scopes(&["patient/Patient.r"]),
                    patient: Some("pat-1".to_owned()),
                }),
                ..pending_request
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

    /// The standing grant "g1" covering every scope of a request for "client"
    /// at the fixture redirect, and its coverage of `request`.
    fn standing_grant_coverage(
        store: &FakeGrantStore,
        request: &CodeRequest,
    ) -> StandingGrantCoverage {
        store
            .tx()
            .create_authorization_code_grant(&code_grant("g1", "client"))
            .unwrap();
        let GrantCoverage::Full(coverage) = GrantCoverage::resolve(
            &mut store.tx(),
            &PresentedClientChange::NoChange,
            "client",
            &request.redirect_uri,
            &request.requested_scopes,
        )
        .unwrap() else {
            panic!("the grant covers the request");
        };
        coverage
    }

    /// When the standing grant "g1" was last used, as stored.
    fn grant_last_used_at(store: &FakeGrantStore) -> Option<DateTime<Utc>> {
        let Some(crate::domain::grant::Grant::AuthorizationCode(grant)) =
            store.tx().grant_by_id("g1").unwrap()
        else {
            panic!("the code grant");
        };
        grant.last_used_at
    }

    /// A code issued under a standing grant stamps that grant used at the
    /// issuing instant; one the Owner approved leaves it alone, and so does a
    /// request denied because its browser session ended.
    #[test]
    fn approve_for_code_stamps_only_the_standing_grant_it_issues_under() {
        let store = FakeGrantStore::default();
        let pending_request = pending_code_request(&store, "req-1");
        let coverage = standing_grant_coverage(&store, &pending_request);

        let owner_approved = pending_code_request(&store, "req-owner");
        assert!(matches!(
            approve(&store, &owner_approved),
            CodeApproval::Issued(_)
        ));
        assert_eq!(grant_last_used_at(&store), None);

        let signed_out = pending_code_request_in_session(&store, "req-signed-out", "gone");
        assert_eq!(
            RequestApprover::within(&mut store.tx())
                .approve_for_code(
                    CodeAuthority::StandingGrant(&coverage),
                    &signed_out,
                    None,
                    "no-code".to_owned(),
                    &StaleSessionCutoff::none(),
                    Utc::now(),
                )
                .unwrap(),
            CodeApproval::BrowserSessionEnded
        );
        assert_eq!(grant_last_used_at(&store), None);

        let now = Utc::now();
        assert!(matches!(
            RequestApprover::within(&mut store.tx())
                .approve_for_code(
                    CodeAuthority::StandingGrant(&coverage),
                    &pending_request,
                    None,
                    "the-code".to_owned(),
                    &StaleSessionCutoff::none(),
                    now,
                )
                .unwrap(),
            CodeApproval::Issued(_)
        ));
        assert_eq!(grant_last_used_at(&store), Some(now));
    }

    /// A request decided since it was read issues nothing — the outcome the
    /// flow maps to not-found — and leaves no code behind.
    #[test]
    fn approve_for_code_issues_nothing_when_the_request_is_no_longer_pending() {
        let store = FakeGrantStore::default();
        let pending_request = pending_code_request(&store, "req-1");
        let denied = pending_request.deny(Utc::now()).unwrap();
        assert!(store
            .tx()
            .replace_code_request(&pending_request, &denied)
            .unwrap());
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
    /// has expired without being revoked, that the cutoff makes stale, or
    /// that names no session, is denied and earns no code; one whose session
    /// stands is approved.
    #[test]
    fn approve_for_code_denies_a_request_whose_browser_session_has_ended() {
        let store = FakeGrantStore::default();
        let now = Utc::now();
        let stale_session_cutoff =
            StaleSessionCutoff::new(now - Duration::minutes(30), HashSet::new());
        let standing = BrowserSession::new_same_device_session(vec![], Duration::hours(8), now);
        let revoked = BrowserSession::new_same_device_session(vec![], Duration::hours(8), now);
        let expired = BrowserSession::new_same_device_session(
            vec![],
            Duration::hours(8),
            now - Duration::hours(9),
        );
        let stale = BrowserSession::new_same_device_session(
            vec![],
            Duration::hours(8),
            now - Duration::hours(1),
        );
        for session in [&standing, &revoked, &expired, &stale] {
            store.tx().insert_browser_session(session).unwrap();
        }
        assert!(store
            .tx()
            .revoke_browser_session(&revoked.sid, now)
            .unwrap());

        for (id, sid) in [
            ("req-revoked", revoked.sid.as_str()),
            ("req-expired", expired.sid.as_str()),
            ("req-stale", stale.sid.as_str()),
            ("req-missing", "no-such-sid"),
        ] {
            let pending_request = pending_code_request_in_session(&store, id, sid);
            assert_eq!(
                approve_under(&store, &pending_request, &stale_session_cutoff),
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
            approve_under(&store, &pending_request, &stale_session_cutoff),
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
                &StaleSessionCutoff::none(),
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
            stored(&store, "req-1"),
            AuthorizationRequest::Code(CodeRequest {
                state: CodeRequestState::Approved(Approval {
                    granted_scopes: owned_scopes(&approved),
                    patient: None,
                }),
                ..pending_request
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
        store.tx().insert_device_request(&read).unwrap();
        let mut tx = store.tx();
        let mut approver = RequestApprover::within(&mut tx);
        let scopes = delegated_scopes(&["patient/Patient.r"]);
        let now = Utc::now();
        assert!(approver
            .approve_for_device(&scopes, &read, None, Some("Kitchen iPad"), now)
            .unwrap());
        let AuthorizationRequest::Device(request) = stored(&store, "dev-1") else {
            panic!("a device request");
        };
        assert_eq!(request.state.status(), RequestStatus::Approved);
        assert!(matches!(request.state, PolledState::Approved(_)));
        assert_eq!(request.device_name.as_deref(), Some("Kitchen iPad"));
        assert!(
            !approver
                .approve_for_device(&scopes, &read, None, None, now)
                .unwrap(),
            "an already-approved request is not approved twice"
        );
    }
}
