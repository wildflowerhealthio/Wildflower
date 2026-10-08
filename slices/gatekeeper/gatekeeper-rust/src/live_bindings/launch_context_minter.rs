//! The [`LaunchContextMinter`] binding — the mint half of the
//! [`LaunchContexts`] capability over the concrete `SqliteGatekeeperStore`, for
//! in-process callers outside the gatekeeper: the apps slice's launch route and
//! the host's launch. Consuming a launch stays inside the gatekeeper, at
//! `/oauth/authorize`.

use chrono::Utc;

use crate::crypto_util::random_token::generate_launch_nonce;
use crate::db::SqliteGatekeeperStore;
use crate::domain::capabilities::oauth::LaunchContexts;
use crate::domain::gatekeeper_error::GatekeeperError;

/// Mint SMART App Launch contexts. Cheap to clone (the store wraps a pool).
/// [`crate::setup_gatekeeper`] hands one out on
/// [`Gatekeeper::launch_context_minter`](crate::Gatekeeper::launch_context_minter).
#[derive(Clone)]
pub struct LaunchContextMinter {
    store: SqliteGatekeeperStore,
}

impl LaunchContextMinter {
    /// A minter over the gatekeeper's store.
    pub(crate) fn new(store: SqliteGatekeeperStore) -> Self {
        LaunchContextMinter { store }
    }

    /// Mint a launch for the OAuth client `client_id` and return its `launch`
    /// value, to put in the app's launch URL. It binds no patient, expires five
    /// minutes from now, and works for one `/oauth/authorize` by that client.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] on a store failure.
    pub fn mint(&self, client_id: &str) -> Result<String, GatekeeperError> {
        LaunchContexts::over(&self.store)
            .mint(client_id, generate_launch_nonce(), Utc::now())
            .map(|launch_context| launch_context.nonce)
    }
}
