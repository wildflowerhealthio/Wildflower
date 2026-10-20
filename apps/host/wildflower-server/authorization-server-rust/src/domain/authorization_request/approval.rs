//! [`Approval`] — what the Owner approved for a code request or a device
//! request.

/// What the Owner approved for a code request or a device request: the
/// scopes granted, and the SMART-on-FHIR patient context bound, if any. A
/// browser pairing's approval binds no patient
/// ([`PairingApproval`](super::pairing::PairingApproval)).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Approval {
    /// The scopes the Owner granted, as the approver's proof clamped them.
    pub granted_scopes: Vec<String>,
    /// The patient context the approval binds, or `None` for none.
    pub patient: Option<String>,
}
