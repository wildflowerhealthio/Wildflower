//! [`HostConsentDecider`] — the host reads and decides a server's pending
//! consents as its Owner, in-process, with no token.
//!
//! The same [`ConsentReader`] and [`ConsentDecider`] the `/access/devices/*`
//! and `/access/oauth-consents/*` routes acquire through `Scoped<…>`, built
//! here with the host Owner's grant (the scopes the host owner token carries)
//! as the approver's, as the loopback dialog's approver is. An approval is
//! remembered as a standing grant, as one made in the launcher is.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use super::state::GatekeeperState;
use super::{LiveConsentDecider, LiveConsentReader};
use crate::crypto_util::random_token::generate_authorization_code;
use crate::domain::capabilities::{
    ApproveDeviceConsentInput, ApproveOAuthConsentInput, ConsentDecider, ConsentOutcome,
    ConsentReader, DeviceConsentView, OAuthConsentView,
};
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::ports::PendingConsentPublisher;

/// Lets the host read and approve or deny this server's waiting consents as
/// its Owner, in-process, without HTTP or a token: the in-process twin of the
/// launcher's `/access/devices/*` and `/access/oauth-consents/*` routes.
///
/// Whoever holds one decides with the host Owner's authority and no token,
/// so only the host gets one: it is built from the [`GatekeeperState`]
/// [`setup_gatekeeper`](crate::setup_gatekeeper) returns, and nothing in the
/// HTTP surface reaches it. Each call is a synchronous store transaction, so
/// a caller on an async runtime runs it on a blocking thread.
#[derive(Clone)]
pub struct HostConsentDecider {
    state: Arc<GatekeeperState>,
}

impl HostConsentDecider {
    /// The decider over the consents of the gatekeeper `state` belongs to.
    #[must_use]
    pub fn new(state: Arc<GatekeeperState>) -> Self {
        Self { state }
    }

    fn reader(&self) -> LiveConsentReader {
        ConsentReader::new(self.state.store.clone())
    }

    fn decider(&self) -> LiveConsentDecider {
        let publisher: Arc<dyn PendingConsentPublisher> = self.state.clone();
        ConsentDecider::new(
            self.state.store.clone(),
            publisher,
            self.state.host_owner_grant.clone(),
            self.state.first_party_client_id.clone(),
        )
    }

    /// The pending device-code consent `user_code`, with its client's name
    /// and the scopes the client may be granted.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::DeviceConsentNotFound`] when no pending, unexpired
    /// device consent has that code; a store failure otherwise.
    pub fn device_consent(&self, user_code: &str) -> Result<DeviceConsentView, GatekeeperError> {
        self.reader().device_consent(user_code)
    }

    /// The pending authorization-code consent `id`, with its client's name
    /// and its registration verdict.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::OAuthConsentNotFound`] when no pending, unexpired
    /// consent has that id; a store failure otherwise.
    pub fn oauth_consent(&self, id: &str) -> Result<OAuthConsentView, GatekeeperError> {
        self.reader().oauth_consent(id)
    }

    /// Approve the device-code consent `user_code` as `input` says, at `now`.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::DeviceConsentNotFound`] when it is no longer
    /// pending, or the error the approval failed with.
    pub fn approve_device(
        &self,
        user_code: &str,
        input: ApproveDeviceConsentInput,
        now: DateTime<Utc>,
    ) -> Result<ConsentOutcome, GatekeeperError> {
        self.decider().approve_device(user_code, input, now)
    }

    /// Deny the device-code consent `user_code`.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::DeviceConsentNotFound`] when it is no longer
    /// pending, or a store failure.
    pub fn deny_device(&self, user_code: &str) -> Result<(), GatekeeperError> {
        self.decider().deny_device(user_code)
    }

    /// Approve the authorization-code consent `id` as `input` says, at `now`,
    /// minting the code the requesting browser's poll collects.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::OAuthConsentNotFound`] when it is no longer
    /// pending, [`GatekeeperError::RegistrationNotAcknowledged`] for a new or
    /// widened registration `input` doesn't acknowledge, or the error the
    /// approval failed with.
    pub fn approve_oauth(
        &self,
        id: &str,
        input: ApproveOAuthConsentInput,
        now: DateTime<Utc>,
    ) -> Result<ConsentOutcome, GatekeeperError> {
        self.decider()
            .approve_oauth(id, input, generate_authorization_code, now)
    }

    /// Deny the authorization-code consent `id`.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::OAuthConsentNotFound`] when it is no longer
    /// pending, or a store failure.
    pub fn deny_oauth(&self, id: &str) -> Result<(), GatekeeperError> {
        self.decider().deny_oauth(id)
    }
}
