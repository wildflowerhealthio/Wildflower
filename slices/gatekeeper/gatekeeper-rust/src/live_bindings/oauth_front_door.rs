//! The pre-auth `/oauth` front-door bindings — the public and client-gated
//! capabilities over the concrete `SqliteGatekeeperStore`. None is scope-gated
//! (a browser arriving at `/authorize` holds no token; a device request is
//! gated by its `AuthenticatedClient` proof), so none has a `Capability` impl;
//! the handlers acquire them through `Live<…>` via [`FromState`].

use std::sync::Arc;

use super::state::GatekeeperState;
use super::FromState;
use crate::db::SqliteGatekeeperStore;
use crate::domain::capabilities::oauth::{
    AuthorizationStatusReader, CodeAuthorizationStarter, DeviceAuthorizer, PublicKeysReader,
};
use crate::ports::PendingConsentPublisher;

/// Start an authorization-code flow — built by the `/oauth/authorize` handler.
pub(crate) type LiveCodeAuthorizationStarter = CodeAuthorizationStarter<SqliteGatekeeperStore>;

impl FromState for LiveCodeAuthorizationStarter {
    fn from_state(state: &Arc<GatekeeperState>) -> Self {
        let publisher: Arc<dyn PendingConsentPublisher> = state.clone();
        CodeAuthorizationStarter::new(
            state.store.clone(),
            publisher,
            state.self_hosted_redirects.clone(),
            state.first_party_client_id.clone(),
        )
    }
}

/// Start a device authorization — built by the `/oauth/device_authorization`
/// handler.
pub(crate) type LiveDeviceAuthorizer = DeviceAuthorizer<SqliteGatekeeperStore>;

impl FromState for LiveDeviceAuthorizer {
    fn from_state(state: &Arc<GatekeeperState>) -> Self {
        let publisher: Arc<dyn PendingConsentPublisher> = state.clone();
        DeviceAuthorizer::new(state.store.clone(), publisher)
    }
}

/// Poll an authorization request — built by the `/oauth/authorize/{id}`
/// handler.
pub(crate) type LiveAuthorizationStatusReader = AuthorizationStatusReader<SqliteGatekeeperStore>;

impl FromState for LiveAuthorizationStatusReader {
    fn from_state(state: &Arc<GatekeeperState>) -> Self {
        AuthorizationStatusReader::new(state.store.clone())
    }
}

/// Serve the public signing keys — built by the `/.well-known/jwks.json`
/// handler.
pub(crate) type LivePublicKeysReader = PublicKeysReader<SqliteGatekeeperStore>;

impl FromState for LivePublicKeysReader {
    fn from_state(state: &Arc<GatekeeperState>) -> Self {
        PublicKeysReader::new(state.store.clone())
    }
}
