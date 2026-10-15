//! [`ServerConsentWatcher`]: a run's authorization server as the host waits on
//! it for a consent it opened to be decided or expire.

use std::fmt;
use std::sync::Arc;

use crate::domain::{ensure_launchable, ConsentKey, LaunchError, ServerStatus};
use wildflowerhealthio_authorization_server::domain::authorization_server_error::AuthorizationServerError;
use wildflowerhealthio_authorization_server::PendingConsentWatcher;

/// Waits, on one run of a server, for a consent waiting there to stop
/// waiting: decided by the Owner, or expired.
///
/// A run puts it in each [`ServerDetail`](crate::ServerDetail) it sets, and `UnitRunner` clears the
/// detail when the run ends, so [`Self::of_launchable_server`] finds one only
/// while the server's run is up. Clones share the run's authorization server,
/// and two are equal when they are the same run's.
#[derive(Clone)]
pub struct ServerConsentWatcher(Arc<PendingConsentWatcher>);

impl ServerConsentWatcher {
    /// The watcher over a run's authorization server, through its
    /// `pending_consent_watcher`.
    #[must_use]
    pub fn new(pending_consent_watcher: PendingConsentWatcher) -> Self {
        Self(Arc::new(pending_consent_watcher))
    }

    /// The watcher of the run of the server whose status is `status`, once
    /// the server can be launched (see [`ensure_launchable`]).
    ///
    /// # Errors
    ///
    /// The [`LaunchError`] that says why the server can't be launched now.
    pub fn of_launchable_server(status: &ServerStatus) -> Result<Self, LaunchError> {
        ensure_launchable(status)?
            .consent_watcher
            .clone()
            .ok_or_else(|| LaunchError::ServerNotRunning {
                domain: status.domain.clone(),
            })
    }

    /// Wait until the consent `consent` names no longer waits for the Owner:
    /// decided, expired, or gone. Answers at once for one that already
    /// doesn't.
    ///
    /// # Errors
    ///
    /// The authorization server's, when reading the request fails or the run
    /// ends first.
    pub async fn until_settled(&self, consent: ConsentKey) -> Result<(), AuthorizationServerError> {
        self.0.until_settled(consent).await
    }
}

impl PartialEq for ServerConsentWatcher {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for ServerConsentWatcher {}

impl fmt::Debug for ServerConsentWatcher {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ServerConsentWatcher")
            .finish_non_exhaustive()
    }
}
