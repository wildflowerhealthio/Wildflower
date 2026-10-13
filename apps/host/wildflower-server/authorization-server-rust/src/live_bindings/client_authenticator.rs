//! The [`LiveClientAuthenticator`] binding — authenticates OAuth clients
//! through the concrete `SqliteGrantStore`. Not scope-gated (a client
//! authenticating is the pre-auth front door), so it has no `Capability` impl;
//! the token-style request extractor builds it through [`FromState`].

use std::sync::Arc;

use super::state::AuthorizationServerState;
use super::FromState;
use crate::db::SqliteGrantStore;
use crate::domain::capabilities::oauth::ClientAuthenticator;

/// Authenticate a client's presented credentials — built by the `TokenRequest`
/// extractor for `/oauth/token` and `/oauth/device_authorization`.
pub(crate) type LiveClientAuthenticator = ClientAuthenticator<SqliteGrantStore>;

impl FromState for LiveClientAuthenticator {
    fn from_state(state: &Arc<AuthorizationServerState>) -> Self {
        ClientAuthenticator::new(state.store.clone())
    }
}
