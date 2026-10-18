//! [`ServerConsentDenier`]: a run's authorization server as the host denies a
//! consent waiting there, as the Owner, from its notification.

use std::fmt;
use std::sync::Arc;

use crate::domain::ConsentKey;
use wildflowerhealthio_authorization_server::domain::authorization_server_error::AuthorizationServerError;
use wildflowerhealthio_authorization_server::PendingConsentDenier;

/// Denies, on one run of a server, a consent waiting there, with the Owner's
/// own authority.
///
/// A run puts it in each [`ServerDetail`](crate::ServerDetail) it sets, and
/// `UnitRunner` clears the detail when the run ends, so the host finds one
/// only while the server's run is up. Clones share the run's authorization
/// server, and two are equal when they are the same run's.
#[derive(Clone)]
pub struct ServerConsentDenier(Arc<PendingConsentDenier>);

impl ServerConsentDenier {
    /// The denier over a run's authorization server, through its
    /// `pending_consent_denier`.
    #[must_use]
    pub fn new(pending_consent_denier: PendingConsentDenier) -> Self {
        Self(Arc::new(pending_consent_denier))
    }

    /// Deny the consent `consent` names, as the consent page's Deny does: the
    /// requester's wait ends as denied.
    ///
    /// # Errors
    ///
    /// The authorization server's: a not-found error for a request that no
    /// longer waits for the Owner, which stays as it was decided, or the one
    /// writing the denial failed with.
    pub async fn deny(&self, consent: ConsentKey) -> Result<(), AuthorizationServerError> {
        self.0.deny(consent).await
    }
}

impl PartialEq for ServerConsentDenier {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for ServerConsentDenier {}

impl fmt::Debug for ServerConsentDenier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ServerConsentDenier")
            .finish_non_exhaustive()
    }
}
