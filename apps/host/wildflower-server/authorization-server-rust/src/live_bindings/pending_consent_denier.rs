//! The [`PendingConsentDenier`] binding — for the host, in-process: declines
//! a pending consent with the Owner's own authority, as the Deny on its
//! notification does, without a browser.

use std::sync::Arc;

use super::state::AuthorizationServerState;
use super::LiveConsentDecider;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::ConsentDecider;
use crate::domain::pending_consent::ConsentKey;
use crate::ports::OwnerApproval;

/// Declines pending consents as the Owner. Cheap to clone.
/// [`crate::setup_authorization_server`] hands one out on
/// [`AuthorizationServer::pending_consent_denier`](crate::AuthorizationServer::pending_consent_denier).
///
/// A denial takes the same path as the consent pages' Deny
/// (`/authorization/oauth-consents/{id}/deny`, `/authorization/devices/{userCode}/deny`,
/// which a browser pairing shares with a device):
/// the request is marked denied, the newest pending consent is republished,
/// and the requester's wait page or device poll ends as denied.
#[derive(Clone)]
pub struct PendingConsentDenier {
    consent_decider: Arc<LiveConsentDecider>,
}

impl PendingConsentDenier {
    /// A denier over the authorization server's `state`, deciding with the
    /// Owner's grant.
    pub(crate) fn new(state: &Arc<AuthorizationServerState>) -> Self {
        let owner_approval: Arc<dyn OwnerApproval> = state.clone();
        PendingConsentDenier {
            consent_decider: Arc::new(ConsentDecider::new(
                state.store.clone(),
                owner_approval,
                state.owner_grant.clone(),
                state.wildflower_host_app_client_id.clone(),
            )),
        }
    }

    /// Decline the request `consent` names, on a blocking thread.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::OAuthConsentNotFound`] or
    /// [`AuthorizationServerError::DeviceConsentNotFound`] when the request
    /// no longer waits for the Owner: decided, expired, or gone. A request
    /// already decided stays as it was decided. The store's error when the
    /// write fails, and [`AuthorizationServerError::Infrastructure`] when the
    /// blocking thread does.
    pub async fn deny(&self, consent: ConsentKey) -> Result<(), AuthorizationServerError> {
        let consent_decider = Arc::clone(&self.consent_decider);
        tokio::task::spawn_blocking(move || match consent {
            ConsentKey::OAuth { id } => consent_decider.deny_oauth(&id).map(|_| ()),
            // A browser pairing is decided at the device page, as a device is.
            ConsentKey::Device { user_code } | ConsentKey::Browser { user_code } => {
                consent_decider.deny_device(&user_code)
            }
        })
        .await
        .map_err(|error| {
            AuthorizationServerError::infrastructure("denying a pending consent", error)
        })?
    }
}
