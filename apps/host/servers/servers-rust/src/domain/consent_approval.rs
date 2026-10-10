//! [`ConsentApproval`], the Owner's approval of a consent, and
//! [`ApprovalOutcome`], what it came to.

use serde::{Deserialize, Serialize};

/// The Owner's approval of a consent, `kind`-tagged as [`ConsentKey`] is,
/// camelCase.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum ConsentApproval {
    /// A device's pairing, with the scopes the Owner left ticked.
    #[serde(rename = "device", rename_all = "camelCase")]
    Device {
        user_code: String,
        approved_scopes: Vec<String>,
        patient: Option<String>,
    },
    /// An app's request, with the scopes the Owner left ticked and whether
    /// the Owner acknowledged a new or changed registration.
    #[serde(rename = "oauth", rename_all = "camelCase")]
    OAuth {
        id: String,
        approved_scopes: Vec<String>,
        patient: Option<String>,
        acknowledged_registration: bool,
    },
}

/// What an approval came to, `{"status": "approved" | "denied"}`: `denied`
/// when none of the approved scopes could be granted, which the gatekeeper
/// records as a denial.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ApprovalOutcome {
    Approved,
    Denied,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{golden, ConsentError, ConsentKey};

    #[test]
    fn the_approvals_outcomes_and_errors_are_as_the_golden_file_says() {
        let golden = golden();
        assert_eq!(
            serde_json::from_value::<Vec<ConsentApproval>>(golden["consentApprovals"].clone())
                .unwrap(),
            [
                ConsentApproval::Device {
                    user_code: "ABCD-EFGH".to_owned(),
                    approved_scopes: vec!["system/Observation.rs".to_owned()],
                    patient: None,
                },
                ConsentApproval::OAuth {
                    id: "req-1".to_owned(),
                    approved_scopes: vec!["launch/patient".to_owned()],
                    patient: Some("pat-1".to_owned()),
                    acknowledged_registration: false,
                },
            ]
        );
        assert_eq!(
            serde_json::to_value([ApprovalOutcome::Approved, ApprovalOutcome::Denied]).unwrap(),
            golden["approvalOutcomes"]
        );
        let errors = [
            ConsentError::ServerNotRunning {
                domain: "ruth.relay.example.com".to_owned(),
            },
            ConsentError::NotPending,
            ConsentError::RegistrationNotAcknowledged,
        ];
        assert_eq!(
            serde_json::to_value(errors).unwrap(),
            golden["consentErrors"]
        );
    }

    #[test]
    fn an_approval_or_key_with_an_unknown_field_is_refused() {
        let approval = serde_json::json!({
            "kind": "oauth",
            "id": "req-1",
            "approvedScopes": [],
            "acknowledgedRegistration": false,
            "grantEverything": true,
        });
        assert!(serde_json::from_value::<ConsentApproval>(approval).is_err());
        let key = serde_json::json!({"kind": "device", "userCode": "A", "id": "B"});
        assert!(serde_json::from_value::<ConsentKey>(key).is_err());
    }
}
