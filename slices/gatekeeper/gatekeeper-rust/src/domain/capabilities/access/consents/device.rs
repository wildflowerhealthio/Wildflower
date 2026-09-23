//! Device-code consent: load/approve/deny the device-flow prompt. An approval
//! obtains a [`DelegatedScopes`] proof and hands it to the writers — the
//! [`RequestApprover`] transitions the request, the [`GrantRecorder`] records
//! the standing device grant.

use chrono::{DateTime, Utc};
use scopes_rust::Grant;

use super::delegation::deny_consent;
use super::{ApproveDeviceConsentInput, ConsentOutcome};
use crate::domain::authority::{ApprovableScopes, DelegatedScopes};
use crate::domain::authorization_request::{
    device_grant_name, AuthorizationRequest, GrantType, RequestStatus,
};
use crate::domain::capabilities::writers::{GrantRecorder, RequestApprover};
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::GatekeeperStore;
use crate::ports::PendingConsentPublisher;

/// Load the authorization request for `user_code` and verify it's a pending,
/// unexpired device-code flow.
pub(super) fn load_pending_device_request(
    store: &impl GatekeeperStore,
    user_code: &str,
) -> Result<AuthorizationRequest, GatekeeperError> {
    match store.pending_authorization_request_by_user_code(user_code)? {
        Some(request)
            if request.grant_type == GrantType::DeviceCode
                && request.status == RequestStatus::Pending
                && request.expires_at > Utc::now() =>
        {
            Ok(request)
        }
        _ => Err(GatekeeperError::DeviceConsentNotFound {
            user_code: user_code.to_owned(),
        }),
    }
}

/// Approve a device-code consent prompt: apply the **expandable** scope decision
/// (up to the client's `allowed_scopes`), transition the request, mint (or
/// refresh) the standing device grant, and republish the popup head. An approval
/// that grants nothing is applied as a **deny**.
pub(super) fn approve_device_consent(
    store: &impl GatekeeperStore,
    publisher: &dyn PendingConsentPublisher,
    user_code: &str,
    input: ApproveDeviceConsentInput,
    approver_grant: &Grant,
    now: DateTime<Utc>,
) -> Result<ConsentOutcome, GatekeeperError> {
    let make_consent_not_found = || GatekeeperError::DeviceConsentNotFound {
        user_code: user_code.to_owned(),
    };
    let device_request = load_pending_device_request(store, user_code)?;
    let client = store
        .client_by_id(&device_request.client_id)?
        .ok_or_else(make_consent_not_found)?;

    // The proof every write below demands: the Owner's approval clamped to
    // what a device prompt may grant and covered by the approver's own grant.
    let Some(delegated_scopes) = DelegatedScopes::clamp(
        approver_grant,
        input.owner_approved_scopes,
        &ApprovableScopes::for_device(&client),
    )?
    else {
        return deny_consent(store, publisher, &device_request.id).map(|()| ConsentOutcome::Denied);
    };

    let request_device_name = input
        .device_name
        .as_deref()
        .or(device_request.device_name.as_deref());
    let approved = RequestApprover::over(store).approve_for_device(
        &delegated_scopes,
        &device_request.id,
        input.patient.as_deref(),
        request_device_name,
    )?;
    if !approved {
        return Err(make_consent_not_found());
    }

    let grant_name = device_grant_name(request_device_name, &client.name);
    GrantRecorder::over(store).record_device_grant(
        &device_request.client_id,
        grant_name,
        &delegated_scopes,
        input.patient.as_deref(),
        now,
    )?;

    publisher.republish_active();
    Ok(ConsentOutcome::Approved { redirect: None })
}

/// Deny the pending device-code request behind `user_code`. Validates it's a live
/// device-flow prompt first, then marks it denied and republishes the popup head.
pub(super) fn deny_device_consent(
    store: &impl GatekeeperStore,
    publisher: &dyn PendingConsentPublisher,
    user_code: &str,
) -> Result<(), GatekeeperError> {
    let device_request = load_pending_device_request(store, user_code)?;
    deny_consent(store, publisher, &device_request.id)
}
