//! [`RequestApprover`] — the writer that moves a pending authorization request
//! to `approved` and, for the code flow, issues the authorization code the
//! client redeems at `/oauth/token`. Both writes demand a
//! [`DelegatedScopes`] proof: the scopes recorded on the request and the code
//! are exactly the proof's, never a slice the flow assembled.

use chrono::{DateTime, Utc};
use url::Url;

use crate::domain::authority::{DelegatedScopes, StandingGrantCoverage};
use crate::domain::authorization_code::{AuthorizationCode, AUTHORIZATION_CODE_TTL};
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

/// The request-specific inputs of a code-flow approval — everything the issued
/// code must be bound to, read from the pending request the flow loaded.
pub(crate) struct CodeApproval<'a> {
    pub(crate) request_id: &'a str,
    pub(crate) client_id: &'a str,
    pub(crate) redirect_uri: &'a Url,
    /// The PKCE challenge the request was parked with; the token endpoint
    /// verifies the redeemer's `code_verifier` against it.
    pub(crate) code_challenge: &'a str,
    /// SMART-on-FHIR patient context the approver bound, if any.
    pub(crate) patient: Option<&'a str>,
    /// The freshly generated code (a CSPRNG opaque token; the flow supplies it so
    /// tests can inject a known value).
    pub(crate) code: String,
    pub(crate) now: DateTime<Utc>,
}

/// The request-specific inputs of a device-flow approval.
pub(crate) struct DeviceApproval<'a> {
    pub(crate) request_id: &'a str,
    /// SMART-on-FHIR patient context the approver bound, if any.
    pub(crate) patient: Option<&'a str>,
    /// The device name to record on the request (the approver's rename, else
    /// the device's own name), or `None` to leave the request's name as is.
    pub(crate) device_name: Option<&'a str>,
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

    /// Approve a code-flow request under `authority` and issue its authorization
    /// code, bound to the request's client, redirect, and PKCE challenge, expiring
    /// [`AUTHORIZATION_CODE_TTL`] after `now`. Returns `None` when the request was
    /// no longer pending (a concurrent decision or expiry won), in which case
    /// nothing is issued; the flow maps that to its own not-found outcome.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] on a store failure.
    pub(crate) fn approve_for_code(
        &self,
        authority: CodeAuthority<'_>,
        approval: CodeApproval<'_>,
    ) -> Result<Option<AuthorizationCode>, GatekeeperError> {
        let scopes = authority.scopes();
        let approved = self.store.approve_authorization_request(
            approval.request_id,
            scopes,
            approval.patient,
            None,
        )?;
        if !approved {
            return Ok(None);
        }
        let authorization_code = AuthorizationCode {
            code: approval.code,
            request_id: approval.request_id.to_owned(),
            client_id: approval.client_id.to_owned(),
            redirect_uri: approval.redirect_uri.clone(),
            code_challenge: approval.code_challenge.to_owned(),
            granted_scopes: scopes.to_vec(),
            patient: approval.patient.map(str::to_owned),
            issued_at: approval.now,
            expires_at: approval.now + AUTHORIZATION_CODE_TTL,
        };
        self.store.issue_authorization_code(&authorization_code)?;
        Ok(Some(authorization_code))
    }

    /// Approve a device-flow request under `scopes`. Returns `false` when the
    /// request was no longer pending, in which case nothing changed.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] on a store failure.
    pub(crate) fn approve_for_device(
        &self,
        scopes: &DelegatedScopes,
        approval: DeviceApproval<'_>,
    ) -> Result<bool, GatekeeperError> {
        self.store.approve_authorization_request(
            approval.request_id,
            scopes.scopes(),
            approval.patient,
            approval.device_name,
        )
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use chrono::Duration;
    use scopes_rust::Grant;

    use super::*;
    use crate::domain::authority::ScopeCeiling;
    use crate::domain::authorization_request::RequestStatus;
    use crate::domain::test_fake::{code_request, device_request, FakeGatekeeperStore};

    fn delegated(scopes: &[&str]) -> DelegatedScopes {
        let requested: HashSet<&str> = scopes.iter().copied().collect();
        DelegatedScopes::clamp(
            &Grant::parse(["system/*.cruds"]),
            scopes.iter().map(|s| (*s).to_owned()).collect(),
            &ScopeCeiling {
                requested: &requested,
                allowed: &requested,
            },
        )
        .expect("owner covers everything")
        .expect("non-empty")
    }

    fn redirect() -> Url {
        Url::parse("https://example.com/cb").expect("valid")
    }

    /// The code flow: the request flips to approved carrying the proof's scopes,
    /// and the issued code is bound to the request's client, redirect, and
    /// challenge with the same scopes.
    #[test]
    fn approve_for_code_records_the_proofs_scopes_on_request_and_code() {
        let store = FakeGatekeeperStore::default();
        store
            .insert_authorization_request(&code_request(
                "req-1",
                RequestStatus::Pending,
                Utc::now() + Duration::minutes(5),
            ))
            .unwrap();
        let now = Utc::now();
        let issued = RequestApprover::over(&store)
            .approve_for_code(
                CodeAuthority::OwnerDelegated(&delegated(&["patient/Patient.r"])),
                CodeApproval {
                    request_id: "req-1",
                    client_id: "client",
                    redirect_uri: &redirect(),
                    code_challenge: "challenge",
                    patient: Some("pat-1"),
                    code: "the-code".to_owned(),
                    now,
                },
            )
            .unwrap()
            .expect("request was pending");
        assert_eq!(issued.granted_scopes, ["patient/Patient.r"]);
        assert_eq!(issued.expires_at, now + AUTHORIZATION_CODE_TTL);
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
        store
            .insert_authorization_request(&code_request(
                "req-1",
                RequestStatus::Denied,
                Utc::now() + Duration::minutes(5),
            ))
            .unwrap();
        let issued = RequestApprover::over(&store)
            .approve_for_code(
                CodeAuthority::OwnerDelegated(&delegated(&["patient/Patient.r"])),
                CodeApproval {
                    request_id: "req-1",
                    client_id: "client",
                    redirect_uri: &redirect(),
                    code_challenge: "challenge",
                    patient: None,
                    code: "the-code".to_owned(),
                    now: Utc::now(),
                },
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
        let approved = approver
            .approve_for_device(
                &delegated(&["patient/Patient.r"]),
                DeviceApproval {
                    request_id: "dev-1",
                    patient: None,
                    device_name: Some("Kitchen iPad"),
                },
            )
            .unwrap();
        assert!(approved);
        let request = store
            .authorization_request_by_id("dev-1")
            .unwrap()
            .expect("present");
        assert_eq!(request.status, RequestStatus::Approved);
        assert_eq!(request.device_name.as_deref(), Some("Kitchen iPad"));

        let again = approver
            .approve_for_device(
                &delegated(&["patient/Patient.r"]),
                DeviceApproval {
                    request_id: "dev-1",
                    patient: None,
                    device_name: None,
                },
            )
            .unwrap();
        assert!(!again, "an already-approved request is not approved twice");
    }
}
