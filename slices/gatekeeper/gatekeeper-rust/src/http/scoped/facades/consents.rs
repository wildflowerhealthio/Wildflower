//! Consent facades — the `wildflower/AuthorizationRequest.*` capabilities behind
//! the `/access/oauth-consents/*` and `/access/devices/*` surfaces.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use scopes_rust::{Grant, Permission, Scope, WildflowerResource};

use crate::domain::actions::{
    self, ApproveDeviceConsentInput, ApproveOAuthConsentInput, ConsentOutcome,
};
use crate::domain::authorization_request::AuthorizationRequest;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::PendingCodeConsent;
use crate::http::scoped::GatedService;
use crate::http::state::GatekeeperState;

/// A consent prompt loaded for the Owner UI to render — the data a `GET`
/// authorization-code consent handler needs, with the client's display name
/// already resolved.
pub(crate) struct OAuthConsentView {
    pub(crate) request: AuthorizationRequest,
    pub(crate) redirect_uri: url::Url,
    pub(crate) client_name: String,
}

/// A device-code consent prompt loaded for the Owner UI — adds the client's
/// full `allowed_scopes` (the expansion envelope the approver may grant up to).
pub(crate) struct DeviceConsentView {
    pub(crate) request: AuthorizationRequest,
    pub(crate) client_name: String,
    pub(crate) allowed_scopes: Vec<String>,
}

/// Read access to pending consent prompts — the `GET` sides of
/// `/access/oauth-consents/{id}` and `/access/devices/{userCode}`.
pub(crate) struct ConsentReader {
    state: Arc<GatekeeperState>,
}

impl GatedService for ConsentReader {
    type State = Arc<GatekeeperState>;
    type Claims = crate::domain::token::VerifiedClaims;

    fn required_scopes() -> Vec<Scope> {
        vec![Scope::wildflower(
            WildflowerResource::AuthorizationRequest,
            Permission::READ,
        )]
    }

    fn build(state: Arc<GatekeeperState>, _granted: &Grant) -> Self {
        ConsentReader { state }
    }
}

impl ConsentReader {
    /// The client's registered display name, or its raw `client_id` when the
    /// lookup misses or fails — the shared fallback both consent views use so the
    /// UI always has *something* to name the app.
    fn client_display_name(&self, client_id: &str) -> String {
        match actions::client_by_id(&self.state.store, client_id) {
            Ok(Some(client)) => client.name,
            _ => client_id.to_owned(),
        }
    }

    /// Load a pending authorization-code consent prompt for the Owner UI.
    pub(crate) fn oauth_consent(&self, id: &str) -> Result<OAuthConsentView, GatekeeperError> {
        let PendingCodeConsent {
            request,
            redirect_uri,
            ..
        } = actions::load_pending_authorization_code_request(&self.state.store, id)?;
        let client_name = self.client_display_name(&request.client_id);
        Ok(OAuthConsentView {
            request,
            redirect_uri,
            client_name,
        })
    }

    /// Load a pending device-code consent prompt for the Owner UI, with the
    /// client's name and expansion envelope resolved.
    pub(crate) fn device_consent(
        &self,
        user_code: &str,
    ) -> Result<DeviceConsentView, GatekeeperError> {
        let request = actions::load_pending_device_request(&self.state.store, user_code)?;
        let (client_name, allowed_scopes) =
            match actions::client_by_id(&self.state.store, &request.client_id) {
                Ok(Some(client)) => (client.name, client.allowed_scopes),
                // Fall back to the raw client_id and no expansion envelope on a
                // miss/failure — the UI still works, the approver just sees less.
                _ => (request.client_id.clone(), Vec::new()),
            };
        Ok(DeviceConsentView {
            request,
            client_name,
            allowed_scopes,
        })
    }
}

/// Decide (approve/deny) pending consent prompts — the `approve`/`deny` sides of
/// both consent surfaces. Gated by `AuthorizationRequest.u`; the approve paths
/// additionally clamp the grant to the approver's own scopes inside the domain
/// action (an approver can't delegate more than they hold).
pub(crate) struct ConsentDecider {
    state: Arc<GatekeeperState>,
}

impl GatedService for ConsentDecider {
    type State = Arc<GatekeeperState>;
    type Claims = crate::domain::token::VerifiedClaims;

    fn required_scopes() -> Vec<Scope> {
        vec![Scope::wildflower(
            WildflowerResource::AuthorizationRequest,
            Permission::UPDATE,
        )]
    }

    fn build(state: Arc<GatekeeperState>, _granted: &Grant) -> Self {
        ConsentDecider { state }
    }
}

impl ConsentDecider {
    /// Approve an authorization-code consent, clamped to `approver`'s scopes.
    pub(crate) fn approve_oauth(
        &self,
        id: &str,
        input: ApproveOAuthConsentInput,
        approver: &Grant,
        generate_code: impl FnOnce() -> String,
        now: DateTime<Utc>,
    ) -> Result<ConsentOutcome, GatekeeperError> {
        actions::approve_oauth_consent(
            &self.state.store,
            &self.state,
            id,
            input,
            approver,
            generate_code,
            now,
        )
    }

    /// Deny an authorization-code consent.
    pub(crate) fn deny_oauth(&self, id: &str) -> Result<(), GatekeeperError> {
        actions::deny_oauth_consent(&self.state.store, &self.state, id)
    }

    /// Approve a device-code consent, clamped to `approver`'s scopes.
    pub(crate) fn approve_device(
        &self,
        user_code: &str,
        input: ApproveDeviceConsentInput,
        approver: &Grant,
        now: DateTime<Utc>,
    ) -> Result<ConsentOutcome, GatekeeperError> {
        actions::approve_device_consent(
            &self.state.store,
            &self.state,
            user_code,
            input,
            approver,
            now,
        )
    }

    /// Deny a device-code consent.
    pub(crate) fn deny_device(&self, user_code: &str) -> Result<(), GatekeeperError> {
        actions::deny_device_consent(&self.state.store, &self.state, user_code)
    }
}
