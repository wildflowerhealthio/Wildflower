use chrono::Utc;

use super::{issue_token, start_refresh_token_family_if_granted};
use crate::domain::authorization_request::{GrantType, RequestStatus, DEVICE_CODE_POLL_INTERVAL};
use crate::domain::client::AllowedGrantType;
use crate::domain::oauth_error_code::OAuthErrorCode;
use crate::domain::GatekeeperStore;
use crate::http::routes::oauth::client_auth::ClientCredentials;
use crate::http::routes::oauth::internal::{
    require_valid_client_for_token, IssueTokenInput, TokenError,
};
use crate::http::state::GatekeeperState;
use crate::http::wire_representations::TokenResponse;

/// Map a device request's current status to its RFC 8628 §3.4/§3.5 poll
/// outcome: `Approved` lets the caller proceed, every other state is the
/// matching `bad_request` the polling client should see. This status read is
/// advisory only — the real single-use gate is the atomic
/// `consume_approved_authorization_request` claim the caller makes next.
fn ensure_device_request_approved(status: RequestStatus) -> Result<(), TokenError> {
    match status {
        RequestStatus::Approved => Ok(()),
        RequestStatus::Pending => Err(TokenError::bad_request(
            OAuthErrorCode::AuthorizationPending,
            None,
        )),
        RequestStatus::Denied => Err(TokenError::bad_request(OAuthErrorCode::AccessDenied, None)),
        RequestStatus::Expired => Err(TokenError::bad_request(OAuthErrorCode::ExpiredToken, None)),
    }
}

pub(super) fn exchange_device_code(
    state: &GatekeeperState,
    origin: &str,
    presented_credentials: &ClientCredentials,
    device_code: &str,
) -> Result<TokenResponse, TokenError> {
    let client = require_valid_client_for_token(&state.store, presented_credentials)?;
    if !client
        .allowed_grant_types
        .contains(&AllowedGrantType::DeviceCode)
    {
        return Err(TokenError::bad_request(
            OAuthErrorCode::UnauthorizedClient,
            Some("Client may not use this grant type"),
        ));
    }
    let request_record = match state.store.authorization_request_by_id(device_code)? {
        Some(record)
            if record.grant_type == GrantType::DeviceCode
                && record.client_id == presented_credentials.client_id =>
        {
            record
        }
        _ => {
            // One response collapses "no such device_code", "wrong client", and
            // "not a device request"; log which (no device_code — it's a secret).
            tracing::warn!(
                presented_client_id = %presented_credentials.client_id,
                "device_code grant rejected: no matching pending/approved device request for this client"
            );
            return Err(TokenError::bad_request(
                OAuthErrorCode::InvalidGrant,
                Some("Unknown device_code"),
            ));
        }
    };
    if request_record.expires_at < Utc::now() {
        return Err(TokenError::bad_request(OAuthErrorCode::ExpiredToken, None));
    }
    if request_record.status == RequestStatus::Pending {
        if let Some(last_polled) = request_record.last_polled_at {
            if Utc::now() - last_polled < DEVICE_CODE_POLL_INTERVAL {
                return Err(TokenError::bad_request(OAuthErrorCode::SlowDown, None));
            }
        }
        state
            .store
            .record_device_poll(&request_record.id, Utc::now())?;
    }
    ensure_device_request_approved(request_record.status)?;
    // Single-use per RFC 8628 §3.4. The status read above is advisory; this
    // atomic `approved` → `expired` claim is the real gate, so two concurrent
    // polls of the same approved request can't both mint — the loser sees
    // `Ok(false)` and is rejected before any token (or refresh family) is
    // issued.
    if !state
        .store
        .consume_approved_authorization_request(&request_record.id)?
    {
        tracing::warn!(
            client_id = %request_record.client_id,
            "device_code grant rejected: request already redeemed (lost the single-use race)"
        );
        return Err(TokenError::bad_request(
            OAuthErrorCode::InvalidGrant,
            Some("Device code already redeemed"),
        ));
    }
    let granted_scopes: &[String] = request_record.granted_scopes.as_deref().unwrap_or(&[]);
    // Resolve the durable device grant minted at approval so the family records
    // it (write-only in v1). The grant is keyed on the *effective* device name —
    // the request's name, or the client name it defaulted to when the device
    // didn't name itself — the same fallback `devices/approve.rs` mints under.
    let effective_device_name = request_record
        .device_name
        .as_deref()
        .unwrap_or(client.name.as_str());
    let grant_id = state
        .store
        .device_grant_by_client_and_device_name(&request_record.client_id, effective_device_name)?
        .map(|grant| grant.id);
    let refresh_token = start_refresh_token_family_if_granted(
        state,
        &request_record.client_id,
        granted_scopes,
        request_record.patient.as_deref(),
        // The device-code grant has no authorization code; its single-use is
        // enforced by `consume_approved_authorization_request` above.
        None,
        grant_id.as_deref(),
    )?;
    issue_token(
        state,
        &IssueTokenInput {
            client_id: &request_record.client_id,
            granted_scopes,
            patient: request_record.patient.as_deref(),
            origin,
        },
        refresh_token,
    )
}
