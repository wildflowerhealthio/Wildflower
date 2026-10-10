//! [`RequestApprover`] — the writer that moves a pending authorization request
//! to `approved` and, for the code flow, issues the authorization code the
//! client redeems at `/oauth/token`. Both writes demand a proof — the device
//! flow a [`DelegatedScopes`], the code flow a [`CodeAuthority`] (delegated
//! scopes or standing-grant coverage) — so the scopes recorded on the request
//! and the code are exactly the proof's, never a slice the flow assembled.

use chrono::{DateTime, Utc};

use crate::domain::authority::{DelegatedScopes, StandingGrantCoverage};
use crate::domain::authorization_code::{
    IssuedAuthorizationCode, PendingCodeRequest, AUTHORIZATION_CODE_TTL,
};
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::{GatekeeperStore, GatekeeperTx};

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

/// Approve pending requests. A borrowed view over the store; the gate is the
/// proof each method takes.
pub(crate) struct RequestApprover<'a, S: GatekeeperStore> {
    store: &'a S,
}

impl<'a, S: GatekeeperStore> RequestApprover<'a, S> {
    /// A writer over `store`.
    pub(crate) fn over(store: &'a S) -> Self {
        RequestApprover { store }
    }

    /// Approve the pending code-flow request under `authority` and issue
    /// `code` for it, bound to the request's client, redirect, and PKCE
    /// challenge and to the SMART-on-FHIR `patient` context (if any), expiring
    /// [`AUTHORIZATION_CODE_TTL`] after `now`. The flow generates `code` (a
    /// CSPRNG opaque token) so tests can inject a known value.
    ///
    /// The approval and the code land in one transaction. Returns `None` when
    /// the request was no longer pending (a concurrent decision or expiry won),
    /// in which case nothing is issued; the flow maps
    /// that to its own not-found outcome.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] on a store failure.
    pub(crate) fn approve_for_code(
        &self,
        authority: CodeAuthority<'_>,
        pending_request: &PendingCodeRequest,
        patient: Option<&str>,
        code: String,
        now: DateTime<Utc>,
    ) -> Result<Option<IssuedAuthorizationCode>, GatekeeperError> {
        let authorized_scopes = authority.authorized_scopes();
        let request = pending_request.request();
        let authorization_code = IssuedAuthorizationCode {
            code,
            request_id: request.id.clone(),
            client_id: request.client_id.clone(),
            redirect_uri: pending_request.redirect_uri().clone(),
            code_challenge: pending_request.code_challenge().to_owned(),
            granted_scopes: authorized_scopes.to_vec(),
            patient: patient.map(str::to_owned),
            issued_at: now,
            expires_at: now + AUTHORIZATION_CODE_TTL,
        };
        // One transaction, so an approved request never exists without its code.
        self.store.transaction(|tx| {
            if !tx.approve_authorization_request(&request.id, authorized_scopes, patient, None)? {
                return Ok(None);
            }
            tx.issue_authorization_code(&authorization_code)?;
            Ok(Some(authorization_code))
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
    /// [`GatekeeperError::Infrastructure`] on a store failure.
    pub(crate) fn approve_for_device(
        &self,
        delegated_scopes: &DelegatedScopes,
        request_id: &str,
        patient: Option<&str>,
        device_name: Option<&str>,
    ) -> Result<bool, GatekeeperError> {
        self.store.approve_authorization_request(
            request_id,
            delegated_scopes.scopes(),
            patient,
            device_name,
        )
    }
}

#[cfg(test)]
mod tests {

    use chrono::Duration;

    use super::*;
    use crate::domain::authorization_request::RequestStatus;
    use crate::domain::test_fake::{
        code_request, delegated_scopes, device_request, FakeGatekeeperStore,
    };

    /// The fixture code request `id`, in `status`, as the approver takes it.
    fn pending_request(
        store: &FakeGatekeeperStore,
        id: &str,
        status: RequestStatus,
    ) -> PendingCodeRequest {
        let request = code_request(id, status, Utc::now() + Duration::minutes(5));
        store.insert_authorization_request(&request).unwrap();
        PendingCodeRequest::from_request(request).expect("a code request")
    }

    /// The code flow: the request flips to approved carrying the proof's scopes,
    /// and the issued_code code is bound to the request's client, redirect, and
    /// challenge with the same scopes.
    #[test]
    fn approve_for_code_records_the_proofs_scopes_on_request_and_code() {
        let store = FakeGatekeeperStore::default();
        let pending_request = pending_request(&store, "req-1", RequestStatus::Pending);
        let now = Utc::now();
        let issued_code = RequestApprover::over(&store)
            .approve_for_code(
                CodeAuthority::OwnerDelegated(&delegated_scopes(&["patient/Patient.r"])),
                &pending_request,
                Some("pat-1"),
                "the-code".to_owned(),
                now,
            )
            .unwrap()
            .expect("request was pending");
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

    /// A request that is no longer pending issues nothing — the `None` the flow
    /// maps to not-found — and leaves no code behind.
    #[test]
    fn approve_for_code_issues_nothing_when_the_request_is_not_pending() {
        let store = FakeGatekeeperStore::default();
        let pending_request = pending_request(&store, "req-1", RequestStatus::Denied);
        let issued_code = RequestApprover::over(&store)
            .approve_for_code(
                CodeAuthority::OwnerDelegated(&delegated_scopes(&["patient/Patient.r"])),
                &pending_request,
                None,
                "the-code".to_owned(),
                Utc::now(),
            )
            .unwrap();
        assert_eq!(issued_code, None);
        assert_eq!(
            store.authorization_code_by_request_id("req-1").unwrap(),
            None
        );
    }

    /// The device flow: the request flips to approved carrying the proof's
    /// scopes and the recorded device name; a non-pending request reports
    /// `false`.
    #[test]
    fn approve_for_device_records_scopes_and_name_only_while_pending() {
        let store = FakeGatekeeperStore::default();
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
