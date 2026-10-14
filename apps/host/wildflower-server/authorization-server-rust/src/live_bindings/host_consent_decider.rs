//! [`HostConsentDecider`] — the host reads and decides a server's pending
//! consents as its Owner, in-process, with no token.
//!
//! The same [`ConsentReader`] and [`ConsentDecider`] the `/authorization/devices/*`
//! and `/authorization/oauth-consents/*` routes acquire through `Scoped<…>`, built
//! here with the host Owner's grant
//! ([`host_owner_scopes`](crate::AuthorizationServerConfig::host_owner_scopes))
//! as the approver's. An approval is remembered as a standing grant, as one
//! made in the launcher is.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use super::state::AuthorizationServerState;
use super::{LiveConsentDecider, LiveConsentReader};
use crate::crypto_util::random_token::generate_authorization_code;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::{
    ApproveDeviceConsentInput, ApproveOAuthConsentInput, ConsentDecider, ConsentOutcome,
    ConsentReader, DeviceConsentView, OAuthConsentView,
};
use crate::ports::OwnerApproval;

/// Lets the host read and approve or deny this server's waiting consents as
/// its Owner, in-process, without HTTP or a token: the in-process twin of the
/// launcher's `/authorization/devices/*` and `/authorization/oauth-consents/*` routes.
///
/// Whoever holds one decides with the host Owner's authority and no token,
/// so only the host gets one: it is built from the [`AuthorizationServerState`]
/// [`setup_authorization_server`](crate::setup_authorization_server) returns, and nothing in the
/// HTTP surface reaches it. Each call is a synchronous store transaction, so
/// a caller on an async runtime runs it on a blocking thread.
#[derive(Clone)]
pub struct HostConsentDecider {
    state: Arc<AuthorizationServerState>,
}

impl HostConsentDecider {
    /// The decider over the consents of the authorization server `state` belongs to.
    #[must_use]
    pub fn new(state: Arc<AuthorizationServerState>) -> Self {
        Self { state }
    }

    fn reader(&self) -> LiveConsentReader {
        ConsentReader::new(self.state.store.clone())
    }

    fn decider(&self) -> LiveConsentDecider {
        let owner_approval: Arc<dyn OwnerApproval> = self.state.clone();
        ConsentDecider::new(
            self.state.store.clone(),
            owner_approval,
            self.state.host_owner_grant.clone(),
            self.state.wildflower_host_app_client_id.clone(),
        )
    }

    /// The pending device-code consent `user_code`, with its client's name
    /// and the scopes the client may be granted.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::DeviceConsentNotFound`] when no pending, unexpired
    /// device consent has that code; a store failure otherwise.
    pub fn device_consent(
        &self,
        user_code: &str,
    ) -> Result<DeviceConsentView, AuthorizationServerError> {
        self.reader().device_consent(user_code)
    }

    /// The pending authorization-code consent `id`, with its client's name
    /// and its registration verdict.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::OAuthConsentNotFound`] when no pending, unexpired
    /// consent has that id; a store failure otherwise.
    pub fn oauth_consent(&self, id: &str) -> Result<OAuthConsentView, AuthorizationServerError> {
        self.reader().oauth_consent(id)
    }

    /// Approve the device-code consent `user_code` as `input` says, at `now`.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::DeviceConsentNotFound`] when it is no longer
    /// pending, or the error the approval failed with.
    pub fn approve_device(
        &self,
        user_code: &str,
        input: ApproveDeviceConsentInput,
        now: DateTime<Utc>,
    ) -> Result<ConsentOutcome, AuthorizationServerError> {
        self.decider().approve_device(user_code, input, now)
    }

    /// Deny the device-code consent `user_code`.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::DeviceConsentNotFound`] when it is no longer
    /// pending, or a store failure.
    pub fn deny_device(&self, user_code: &str) -> Result<(), AuthorizationServerError> {
        self.decider().deny_device(user_code)
    }

    /// Approve the authorization-code consent `id` as `input` says, at `now`,
    /// minting the code the requesting browser's poll collects.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::OAuthConsentNotFound`] when it is no longer
    /// pending, [`AuthorizationServerError::RegistrationNotAcknowledged`] for a new or
    /// widened registration `input` doesn't acknowledge, or the error the
    /// approval failed with.
    pub fn approve_oauth(
        &self,
        id: &str,
        input: ApproveOAuthConsentInput,
        now: DateTime<Utc>,
    ) -> Result<ConsentOutcome, AuthorizationServerError> {
        self.decider()
            .approve_oauth(id, input, generate_authorization_code, now)
    }

    /// Deny the authorization-code consent `id`.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::OAuthConsentNotFound`] when it is no longer
    /// pending, or a store failure.
    pub fn deny_oauth(&self, id: &str) -> Result<(), AuthorizationServerError> {
        self.decider().deny_oauth(id)
    }
}
