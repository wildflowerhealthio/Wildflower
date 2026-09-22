//! [`RequestApprover`] — the writer that moves a pending authorization request
//! to `approved` and, for the code flow, issues the authorization code the
//! client redeems at `/oauth/token`. Both writes demand a
//! [`DelegatedScopes`] proof: the scopes recorded on the request and the code
//! are exactly the proof's, never a slice the flow assembled.

use chrono::{DateTime, Utc};

use crate::domain::authority::{DelegatedScopes, StandingGrantCoverage};
use crate::domain::authorization_code::{
    IssuedAuthorizationCode, PendingCodeRequest, AUTHORIZATION_CODE_TTL,
};
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::GatekeeperStore;

/// On whose authority a code-flow request is approved — the two proofs that
/// may issue an authorization code. Listing them here is the point: a reader
/// auditing "who can issue a code with no human?" finds
/// [`StandingGrant`](Self::StandingGrant) by name.
pub(crate) enum CodeAuthority<'a> {
    /// The Owner approved the prompt.
    OwnerDelegated(&'a DelegatedScopes),
    /// A standing grant already covered every requested scope.
    StandingGrant(&'a StandingGrantCoverage),
}

impl CodeAuthority<'_> {
    fn scopes(&self) -> &[String] {
        match self {
            CodeAuthority::OwnerDelegated(delegated) => delegated.scopes(),
            CodeAuthority::StandingGrant(standing) => standing.scopes(),
        }
    }
}

/// Approve pending requests. A borrowed view over the store; the gate is the
/// [`DelegatedScopes`] each method takes.
pub(crate) struct RequestApprover<'a, S: GatekeeperStore> {
    store: &'a S,
}

impl<'a, S: GatekeeperStore> RequestApprover<'a, S> {
    /// A writer over `store`.
    pub(crate) fn over(store: &'a S) -> Self {
        RequestApprover { store }
    }

    /// Approve the `pending` code-flow request under `authority` and issue
    /// `code` for it, bound to the request's client, redirect, and PKCE
    /// challenge and to the SMART-on-FHIR `patient` context (if any), expiring
    /// [`AUTHORIZATION_CODE_TTL`] after `now`. The flow generates `code` (a
    /// CSPRNG opaque token) so tests can inject a known value.
    ///
    /// Returns `None` when the request was no longer pending (a concurrent
    /// decision or expiry won), in which case nothing is issued; the flow maps
    /// that to its own not-found outcome.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] on a store failure.
    pub(crate) fn approve_for_code(
        &self,
        authority: CodeAuthority<'_>,
        pending: &PendingCodeRequest,
        patient: Option<&str>,
        code: String,
        now: DateTime<Utc>,
    ) -> Result<Option<IssuedAuthorizationCode>, GatekeeperError> {
        let scopes = authority.scopes();
        let request = &pending.request;
        let approved =
            self.store
                .approve_authorization_request(&request.id, scopes, patient, None)?;
        if !approved {
            return Ok(None);
        }
        let authorization_code = IssuedAuthorizationCode {
            code,
            request_id: request.id.clone(),
            client_id: request.client_id.clone(),
            redirect_uri: pending.redirect_uri.clone(),
            code_challenge: pending.code_challenge.clone(),
            granted_scopes: scopes.to_vec(),
            patient: patient.map(str::to_owned),
            issued_at: now,
            expires_at: now + AUTHORIZATION_CODE_TTL,
        };
        self.store.issue_authorization_code(&authorization_code)?;
        Ok(Some(authorization_code))
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
    use std::collections::HashSet;

    use chrono::Duration;
    use scopes_rust::Grant;

    use super::*;
    use crate::domain::authority::ApprovableScopes;
    use crate::domain::authorization_request::RequestStatus;
    use crate::domain::test_fake::{code_request, device_request, FakeGatekeeperStore};

    fn delegated_scopes(scopes: &[&str]) -> DelegatedScopes {
        let requested: HashSet<&str> = scopes.iter().copied().collect();
        DelegatedScopes::clamp(
            &Grant::parse(["system/*.cruds"]),
            scopes.iter().map(|s| (*s).to_owned()).collect(),
            &ApprovableScopes {
                requested_scopes: &requested,
                allowed_scopes: &requested,
            },
        )
        .expect("owner covers everything")
        .expect("non-empty")
    }

    /// The fixture code request `id`, in `status`, as the approver takes it.
    fn pending(store: &FakeGatekeeperStore, id: &str, status: RequestStatus) -> PendingCodeRequest {
        let request = code_request(id, status, Utc::now() + Duration::minutes(5));
        store.insert_authorization_request(&request).unwrap();
        PendingCodeRequest {
            redirect_uri: request.redirect_uri.clone().expect("a code request"),
            code_challenge: request.code_challenge.clone().expect("a code request"),
            request,
        }
    }

    /// The code flow: the request flips to approved carrying the proof's scopes,
    /// and the issued code is bound to the request's client, redirect, and
    /// challenge with the same scopes.
    #[test]
    fn approve_for_code_records_the_proofs_scopes_on_request_and_code() {
        let store = FakeGatekeeperStore::default();
        let pending = pending(&store, "req-1", RequestStatus::Pending);
        let now = Utc::now();
        let issued = RequestApprover::over(&store)
            .approve_for_code(
                CodeAuthority::OwnerDelegated(&delegated_scopes(&["patient/Patient.r"])),
                &pending,
                Some("pat-1"),
                "the-code".to_owned(),
                now,
            )
            .unwrap()
            .expect("request was pending");
        assert_eq!(issued.granted_scopes, ["patient/Patient.r"]);
        assert_eq!(issued.expires_at, now + AUTHORIZATION_CODE_TTL);
        assert_eq!(issued.code_challenge, pending.code_challenge);
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
            .expect("code issued");
        assert_eq!(stored.code, "the-code");
        assert_eq!(stored.patient.as_deref(), Some("pat-1"));
    }

    /// A request that is no longer pending issues nothing — the `None` the flow
    /// maps to not-found — and leaves no code behind.
    #[test]
    fn approve_for_code_issues_nothing_when_the_request_is_not_pending() {
        let store = FakeGatekeeperStore::default();
        let pending = pending(&store, "req-1", RequestStatus::Denied);
        let issued = RequestApprover::over(&store)
            .approve_for_code(
                CodeAuthority::OwnerDelegated(&delegated_scopes(&["patient/Patient.r"])),
                &pending,
                None,
                "the-code".to_owned(),
                Utc::now(),
            )
            .unwrap();
        assert_eq!(issued, None);
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
