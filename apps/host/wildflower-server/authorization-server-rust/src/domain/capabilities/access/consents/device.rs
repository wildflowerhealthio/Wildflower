//! The device page's consent prompt, keyed by its `user_code`: a device-flow
//! request, or a browser pairing — [`ConsentReader::device_consent`] and
//! [`ConsentDecider`]'s `approve_device` / `deny_device`. An approval obtains
//! a [`DelegatedScopes`] proof and hands it to the writers in the same scope —
//! the [`RequestApprover`] transitions the request, and for a device the
//! [`GrantRecorder`] records the standing device grant. A browser pairing
//! records no grant: the pairing page's poll starts the approved session.

use chrono::{DateTime, Utc};

use super::delegation::deny_pending_request;
use super::{
    ApproveDeviceConsentInput, ConsentDecider, ConsentOutcome, ConsentReader, DeviceConsentView,
};
use crate::domain::authority::{ApprovableScopes, DelegatedScopes};
use crate::domain::authorization_request::{
    device_grant_name, AuthorizationRequest, DeviceRequest, RequestKind,
};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::writers::{GrantRecorder, RequestApprover};
use crate::domain::grant_store::{AuthorizationRequestsTx, ClientsTx as _};
use crate::domain::{GrantStore, GrantTx};

impl<S: GrantStore> ConsentReader<S> {
    /// Load a pending device-page consent prompt for the launcher, with the
    /// client's name and expansion envelope resolved, and the approval scopes
    /// the reader lacks.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::DeviceConsentNotFound`] when `user_code`
    /// names no live device-page prompt; a store failure.
    pub(crate) fn device_consent(
        &self,
        user_code: &str,
        now: DateTime<Utc>,
    ) -> Result<DeviceConsentView, AuthorizationServerError> {
        let (request, maybe_existing_client) = self.store.read(|tx| {
            let request = load_pending_request_by_user_code(tx, user_code, now)?;
            let maybe_existing_client = tx.client_by_id(request.client_id())?;
            Ok::<_, AuthorizationServerError>((request, maybe_existing_client))
        })?;
        let (client_name, registered_client_scopes) = match maybe_existing_client {
            Some(existing_client) => (existing_client.name, existing_client.allowed_scopes),
            None => (request.client_id().to_owned(), Vec::new()),
        };
        let (approvable, starting_scopes, approvable_scopes) = match request.kind() {
            RequestKind::BrowserPairing(_) => {
                let approvable = ApprovableScopes::for_browser_pairing();
                let starting_scopes = approvable.delegable_scopes(&self.reader_grant);
                (approvable, starting_scopes, crate::owner_scopes())
            }
            RequestKind::DeviceCode(_) | RequestKind::AuthorizationCode(_) => (
                ApprovableScopes::for_device(&registered_client_scopes),
                request.requested_scopes().to_vec(),
                registered_client_scopes,
            ),
        };
        Ok(DeviceConsentView {
            request,
            client_name,
            starting_scopes,
            approvable_scopes,
            missing_approval_scopes: approvable.missing_approval_scopes(&self.reader_grant),
        })
    }
}

impl<S: GrantStore> ConsentDecider<S> {
    /// Approve the device-page consent prompt `user_code`: apply the
    /// **expandable** scope decision (up to the client's `allowed_scopes` for
    /// a device, up to [`OWNER_SCOPES`](crate::OWNER_SCOPES) for a browser
    /// pairing), transition the request, for a device mint (or refresh) the
    /// standing device grant, and republish the popup head. An approval that
    /// grants nothing is applied as a **deny**.
    ///
    /// # Errors
    ///
    /// [`InsufficientScope`](AuthorizationServerError::InsufficientScope) when
    /// the approver lacks the request's approval scopes (see
    /// [`ApprovableScopes::missing_approval_scopes`]: `wildflower/Grant.c` for a
    /// device's standing grant, which a browser pairing doesn't record), and
    /// [`InsufficientApproverScope`](AuthorizationServerError::InsufficientApproverScope)
    /// for a resource scope beyond the approver's own authority, both writing
    /// nothing; [`DeviceConsentNotFound`](AuthorizationServerError::DeviceConsentNotFound)
    /// when `user_code` names no live prompt.
    pub(crate) fn approve_device(
        &self,
        user_code: &str,
        input: ApproveDeviceConsentInput,
        now: DateTime<Utc>,
    ) -> Result<ConsentOutcome, AuthorizationServerError> {
        self.decide_and_republish(|tx| {
            let request = load_pending_request_by_user_code(tx, user_code, now)?;
            match request.kind() {
                RequestKind::BrowserPairing(_) => {
                    self.approve_browser_pairing_in(tx, user_code, &request, input, now)
                }
                RequestKind::DeviceCode(device_request) => {
                    self.approve_device_in(tx, user_code, &request, device_request, input, now)
                }
                RequestKind::AuthorizationCode(_) => Err(consent_not_found(user_code)),
            }
        })
    }

    /// Deny the device-page consent prompt `user_code` and republish the popup
    /// head.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::DeviceConsentNotFound`] when `user_code`
    /// names no live prompt.
    pub(crate) fn deny_device(
        &self,
        user_code: &str,
        now: DateTime<Utc>,
    ) -> Result<(), AuthorizationServerError> {
        self.decide_and_republish(|tx| {
            let request = load_pending_request_by_user_code(tx, user_code, now)?;
            deny_pending_request(tx, &request, now, || consent_not_found(user_code))
        })
    }

    /// Approve the pending device request `request`, carrying
    /// `device_request`, inside the approval's write scope `tx`.
    fn approve_device_in(
        &self,
        tx: &mut impl GrantTx,
        user_code: &str,
        request: &AuthorizationRequest,
        device_request: &DeviceRequest,
        input: ApproveDeviceConsentInput,
        now: DateTime<Utc>,
    ) -> Result<ConsentOutcome, AuthorizationServerError> {
        let client = tx
            .client_by_id(request.client_id())?
            .ok_or_else(|| consent_not_found(user_code))?;
        // The proof every write below demands: the approver holds a device
        // prompt's approval scopes, and the Owner's approval is clamped to what
        // it may grant and covered by the approver's own grant.
        let Some(delegated_scopes) = DelegatedScopes::clamp(
            &self.approver_grant,
            input.owner_approved_scopes,
            &ApprovableScopes::for_device(&client.allowed_scopes),
        )?
        else {
            deny_pending_request(tx, request, now, || consent_not_found(user_code))?;
            return Ok(ConsentOutcome::Denied { redirect: None });
        };
        if !RequestApprover::within(tx).approve_for_device(
            &delegated_scopes,
            request,
            input.patient.as_deref(),
            input.device_name.as_deref(),
            now,
        )? {
            return Err(consent_not_found(user_code));
        }
        let request_device_name = input
            .device_name
            .as_deref()
            .or(device_request.device_name.as_deref());
        let grant_name = device_grant_name(request_device_name, &client.name);
        GrantRecorder::within(tx).record_device_grant(
            request.client_id(),
            grant_name,
            &delegated_scopes,
            input.patient.as_deref(),
            now,
        )?;
        Ok(ConsentOutcome::Approved { redirect: None })
    }

    /// Approve the pending browser pairing `request`, inside the approval's
    /// write scope `tx`: clamp the Owner's ticks to
    /// [`ApprovableScopes::for_browser_pairing`] and the approver's own grant,
    /// and transition the request under the browser name the approver left.
    /// Nothing granted is a deny.
    fn approve_browser_pairing_in(
        &self,
        tx: &mut impl GrantTx,
        user_code: &str,
        request: &AuthorizationRequest,
        input: ApproveDeviceConsentInput,
        now: DateTime<Utc>,
    ) -> Result<ConsentOutcome, AuthorizationServerError> {
        let Some(delegated_scopes) = DelegatedScopes::clamp(
            &self.approver_grant,
            input.owner_approved_scopes,
            &ApprovableScopes::for_browser_pairing(),
        )?
        else {
            deny_pending_request(tx, request, now, || consent_not_found(user_code))?;
            return Ok(ConsentOutcome::Denied { redirect: None });
        };
        if !RequestApprover::within(tx).approve_browser_pairing(
            &delegated_scopes,
            request,
            input.device_name.as_deref(),
            now,
        )? {
            return Err(consent_not_found(user_code));
        }
        Ok(ConsentOutcome::Approved { redirect: None })
    }
}

/// The device-page prompt `user_code` — a device request or a browser
/// pairing — pending at `now`. Anything else is not found.
fn load_pending_request_by_user_code(
    tx: &mut impl AuthorizationRequestsTx,
    user_code: &str,
    now: DateTime<Utc>,
) -> Result<AuthorizationRequest, AuthorizationServerError> {
    tx.pending_authorization_request_by_user_code(user_code)?
        .filter(|request| request.pending_at(now) && request.code().is_none())
        .ok_or_else(|| consent_not_found(user_code))
}

/// The device-page prompt `user_code` is not (or no longer) a live prompt.
fn consent_not_found(user_code: &str) -> AuthorizationServerError {
    AuthorizationServerError::DeviceConsentNotFound {
        user_code: user_code.to_owned(),
    }
}
