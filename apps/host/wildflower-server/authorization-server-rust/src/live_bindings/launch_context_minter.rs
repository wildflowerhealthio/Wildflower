//! The [`LaunchContextMinter`] binding — the mint half of the
//! [`LaunchContexts`] capability over the concrete `SqliteGrantStore`, for
//! in-process callers outside the authorization server: the apps slice's launch route and
//! the base's launch. Consuming a launch stays inside the authorization server, at
//! `/oauth/authorize`.

use chrono::Utc;

use crate::crypto_util::random_token::generate_launch_nonce;
use crate::db::SqliteGrantStore;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::oauth::LaunchContexts;

/// Mint SMART App Launch contexts. Cheap to clone (the store wraps a pool).
/// [`crate::setup_authorization_server`] hands one out on
/// [`AuthorizationServer::launch_context_minter`](crate::AuthorizationServer::launch_context_minter).
#[derive(Clone)]
pub struct LaunchContextMinter {
    launch_contexts: LaunchContexts<SqliteGrantStore>,
}

impl LaunchContextMinter {
    /// A minter over the authorization server's store.
    pub(crate) fn new(store: SqliteGrantStore) -> Self {
        LaunchContextMinter {
            launch_contexts: LaunchContexts::new(store),
        }
    }

    /// Mint a launch for the OAuth client `client_id` and return its `launch`
    /// value, to put in the app's launch URL. It binds no patient, expires five
    /// minutes from now, and works for one `/oauth/authorize` by that client.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub fn mint(&self, client_id: &str) -> Result<String, AuthorizationServerError> {
        self.launch_contexts
            .mint(client_id, generate_launch_nonce(), Utc::now())
            .map(|launch_context| launch_context.nonce)
    }

    /// Mint a launch any OAuth client may consume and return its `launch`
    /// value, for the base's launch of a server's launcher, which can be any
    /// app. It binds no patient, expires five minutes from now, and works for
    /// one `/oauth/authorize`, by whichever client presents it first.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub fn mint_for_any_client(&self) -> Result<String, AuthorizationServerError> {
        self.launch_contexts
            .mint_for_any_client(generate_launch_nonce(), Utc::now())
            .map(|launch_context| launch_context.nonce)
    }
}
