//! Device-code consent: load/approve/deny the device-flow prompt and the standing
//! device grant its approval upserts.

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use scopes_rust::{grantable_scopes, Grant};
use uuid::Uuid;

use super::delegation::{deny_consent, ensure_approver_covers};
use super::{ApproveDeviceConsentInput, ConsentOutcome};
use crate::domain::authorization_request::{AuthorizationRequest, GrantType, RequestStatus};
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::grant::{CumulativeConsent, DeviceGrant};
use crate::domain::{GatekeeperStore, GatekeeperTx};
use crate::ports::PendingConsentPublisher;

/// Load the authorization request for `user_code` and verify it's a pending,
/// unexpired device-code flow.
pub(super) fn load_pending_device_request(
    store: &impl GatekeeperStore,
    user_code: &str,
) -> Result<AuthorizationRequest, GatekeeperError> {
    match store.pending_authorization_request_by_user_code(user_code)? {
        Some(r)
            if r.grant_type == GrantType::DeviceCode
                && r.status == RequestStatus::Pending
                && r.expires_at > Utc::now() =>
        {
            Ok(r)
        }
        _ => Err(GatekeeperError::DeviceConsentNotFound {
            user_code: user_code.to_owned(),
        }),
    }
}

/// Insert or cumulatively update the standing device grant for
/// `(client_id, device_name)`, same read-merge-write-under-`BEGIN IMMEDIATE`
/// shape as [`upsert_authorization_code_grant`], keyed on the device name.
fn upsert_device_grant(
    store: &impl GatekeeperStore,
    client_id: &str,
    device_name: &str,
    scopes: &[String],
    patient: Option<&str>,
    now: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    store.immediate_transaction(|tx| {
        match tx.device_grant_by_client_and_device_name(client_id, device_name)? {
            Some(mut grant) => {
                grant.absorb_reapproval(scopes, patient, now);
                tx.update_device_grant(&grant)
            }
            None => tx.create_device_grant(&DeviceGrant {
                id: Uuid::new_v4().to_string(),
                client_id: client_id.to_owned(),
                scopes: scopes.to_vec(),
                granted_at: now,
                last_used_at: None,
                patient: patient.map(str::to_owned),
                device_name: device_name.to_owned(),
            }),
        }
    })
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
    approver: &Grant,
    now: DateTime<Utc>,
) -> Result<ConsentOutcome, GatekeeperError> {
    let make_consent_not_found = || GatekeeperError::DeviceConsentNotFound {
        user_code: user_code.to_owned(),
    };
    let device_request = load_pending_device_request(store, user_code)?;
    let client = store
        .client_by_id(&device_request.client_id)?
        .ok_or_else(make_consent_not_found)?;

    let allowed: HashSet<&str> = client.allowed_scopes.iter().map(String::as_str).collect();
    let granted_scopes = grantable_scopes(input.approved_scopes, &allowed, &allowed);
    if granted_scopes.is_empty() {
        return deny_consent(store, publisher, &device_request.id).map(|()| ConsentOutcome::Denied);
    }
    ensure_approver_covers(&granted_scopes, approver)?;

    let request_device_name = input
        .device_name
        .as_deref()
        .or(device_request.device_name.as_deref());
    let approved = store.approve_authorization_request(
        &device_request.id,
        &granted_scopes,
        input.patient.as_deref(),
        request_device_name,
    )?;
    if !approved {
        return Err(make_consent_not_found());
    }

    let effective_device_name = request_device_name.unwrap_or(client.name.as_str());
    upsert_device_grant(
        store,
        &device_request.client_id,
        effective_device_name,
        &granted_scopes,
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
