//! The [`PendingConsentWatcher`] binding — for the host, in-process: waits
//! until one pending consent stops waiting for the Owner, so the host can
//! close the page it opened the request at.

use chrono::Utc;
use tokio::sync::watch;

use crate::db::SqliteGrantStore;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::pending_consent::ConsentKey;

/// Watches whether a pending consent still waits for the Owner. Cheap to
/// clone. [`crate::setup_authorization_server`] hands one out on
/// [`AuthorizationServer::pending_consent_watcher`](crate::AuthorizationServer::pending_consent_watcher).
///
/// It rereads the request each time the authorization server recomputes its
/// newest pending consent: after every transition that may change which
/// requests are pending (a new request, an approve or a deny), and on the
/// reaper's tick, which is how an expiry is noticed. Each recompute is
/// signalled whether or not the newest changed, so a request decided while a
/// newer one stays newest is still seen settle.
#[derive(Clone)]
pub struct PendingConsentWatcher {
    store: SqliteGrantStore,
    pending_consents_recomputed_rx: watch::Receiver<()>,
}

impl PendingConsentWatcher {
    /// A watcher over the authorization server's `store`, woken through
    /// `pending_consents_recomputed_rx`.
    pub(crate) fn new(
        store: SqliteGrantStore,
        pending_consents_recomputed_rx: watch::Receiver<()>,
    ) -> Self {
        PendingConsentWatcher {
            store,
            pending_consents_recomputed_rx,
        }
    }

    /// Wait until the request `consent` names no longer waits for the Owner:
    /// decided, expired, or gone. Answers at once for one that already
    /// doesn't. Each read runs on a blocking thread.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] when reading the request
    /// fails, or when the authorization server stops before the request
    /// settles.
    pub async fn until_settled(&self, consent: ConsentKey) -> Result<(), AuthorizationServerError> {
        let mut pending_consents_recomputed_rx = self.pending_consents_recomputed_rx.clone();
        loop {
            pending_consents_recomputed_rx.borrow_and_update();
            let store = self.store.clone();
            let read_consent = consent.clone();
            let pending =
                tokio::task::spawn_blocking(move || read_consent.is_pending_in(&store, Utc::now()))
                    .await
                    .map_err(|error| {
                        AuthorizationServerError::infrastructure("reading a pending consent", error)
                    })??;
            if !pending {
                return Ok(());
            }
            if pending_consents_recomputed_rx.changed().await.is_err() {
                return Err(AuthorizationServerError::infrastructure(
                    "watching a pending consent",
                    "the authorization server stopped",
                ));
            }
        }
    }
}
