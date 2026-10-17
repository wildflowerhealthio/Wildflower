//! Device-page consent: load/approve/deny the requests the device page decides
//! by their `user_code` — a device-flow prompt, or a browser pairing. An
//! approval obtains a [`DelegatedScopes`] proof and hands it to the writers —
//! the [`RequestApprover`] transitions the request, and for a device the
//! [`GrantRecorder`] records the standing device grant. A browser pairing
//! records no grant: the pairing page's poll starts the approved session.

use chrono::{DateTime, Utc};
use wildflowerhealthio_scopes::Grant;

use super::delegation::deny_consent;
use super::{ApproveDeviceConsentInput, ConsentOutcome};
use crate::domain::authority::{ApprovableScopes, DelegatedScopes};
use crate::domain::authorization_request::{
    device_grant_name, AuthorizationRequest, GrantType, RequestStatus,
};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::writers::{GrantRecorder, RequestApprover};
use crate::domain::GrantStore;
use crate::ports::OwnerApproval;

/// Load the authorization request for `user_code` and verify it's a pending,
/// unexpired device-code flow or browser pairing.
pub(super) fn load_pending_request_by_user_code(
    store: &impl GrantStore,
    user_code: &str,
) -> Result<AuthorizationRequest, AuthorizationServerError> {
    match store.pending_authorization_request_by_user_code(user_code)? {
        Some(request)
            if matches!(
                request.grant_type,
                GrantType::DeviceCode | GrantType::BrowserPairing
            ) && request.status == RequestStatus::Pending
                && request.expires_at > Utc::now() =>
        {
            Ok(request)
        }
        _ => Err(AuthorizationServerError::DeviceConsentNotFound {
            user_code: user_code.to_owned(),
        }),
    }
}

/// Approve a device-page consent prompt: apply the **expandable** scope
/// decision (up to the client's `allowed_scopes` for a device, up to
/// [`OWNER_SCOPES`](crate::OWNER_SCOPES) for a browser pairing), transition the
/// request, for a device mint (or refresh) the standing device grant, and
/// republish the popup head. An approval that grants nothing is applied as a
/// **deny**.
pub(super) fn approve_device_consent(
    store: &impl GrantStore,
    owner_approval: &dyn OwnerApproval,
    user_code: &str,
    input: ApproveDeviceConsentInput,
    approver_grant: &Grant,
    now: DateTime<Utc>,
) -> Result<ConsentOutcome, AuthorizationServerError> {
    let make_consent_not_found = || AuthorizationServerError::DeviceConsentNotFound {
        user_code: user_code.to_owned(),
    };
    let device_request = load_pending_request_by_user_code(store, user_code)?;
    if device_request.grant_type == GrantType::BrowserPairing {
        return approve_browser_pairing(
            store,
            owner_approval,
            &device_request,
            input,
            approver_grant,
            make_consent_not_found,
        );
    }
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
        return deny_consent(
            store,
            owner_approval,
            &device_request.id,
            make_consent_not_found,
        )
        .map(|()| ConsentOutcome::Denied { redirect: None });
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

    owner_approval.republish_active();
    Ok(ConsentOutcome::Approved { redirect: None })
}

/// Approve the pending browser pairing `pairing_request`: clamp the Owner's
/// ticks to [`ApprovableScopes::for_browser_pairing`] and the approver's own
/// grant, and transition the request under the browser name the approver
/// left. Nothing granted is a deny.
fn approve_browser_pairing(
    store: &impl GrantStore,
    owner_approval: &dyn OwnerApproval,
    pairing_request: &AuthorizationRequest,
    input: ApproveDeviceConsentInput,
    approver_grant: &Grant,
    make_consent_not_found: impl Fn() -> AuthorizationServerError,
) -> Result<ConsentOutcome, AuthorizationServerError> {
    let Some(delegated_scopes) = DelegatedScopes::clamp(
        approver_grant,
        input.owner_approved_scopes,
        &ApprovableScopes::for_browser_pairing(),
    )?
    else {
        return deny_consent(
            store,
            owner_approval,
            &pairing_request.id,
            make_consent_not_found,
        )
        .map(|()| ConsentOutcome::Denied { redirect: None });
    };
    let browser_name = input
        .device_name
        .as_deref()
        .or(pairing_request.device_name.as_deref())
        .ok_or_else(&make_consent_not_found)?;
    if !RequestApprover::over(store).approve_browser_pairing(
        &delegated_scopes,
        &pairing_request.id,
        browser_name,
    )? {
        return Err(make_consent_not_found());
    }
    owner_approval.republish_active();
    Ok(ConsentOutcome::Approved { redirect: None })
}

/// Deny the pending device-page request behind `user_code`. Validates it's a
/// live device-flow prompt or browser pairing first, then marks it denied and
/// republishes the popup head.
pub(super) fn deny_device_consent(
    store: &impl GrantStore,
    owner_approval: &dyn OwnerApproval,
    user_code: &str,
) -> Result<(), AuthorizationServerError> {
    let device_request = load_pending_request_by_user_code(store, user_code)?;
    deny_consent(store, owner_approval, &device_request.id, || {
        AuthorizationServerError::DeviceConsentNotFound {
            user_code: user_code.to_owned(),
        }
    })
}
