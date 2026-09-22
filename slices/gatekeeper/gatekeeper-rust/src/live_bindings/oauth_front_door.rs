//! The pre-auth `/oauth` front-door bindings — the public and client-gated
//! capabilities over the concrete `SqliteGatekeeperStore`. None is scope-gated
//! (a browser arriving at `/authorize` holds no token; a device request is
//! gated by its `AuthenticatedClient` proof), so none has a `Capability` impl;
//! the handlers build them from the state.

use std::sync::Arc;

use super::state::GatekeeperState;
use crate::db::SqliteGatekeeperStore;
use crate::domain::capabilities::oauth::{
    AuthorizationStatusReader, CodeAuthorizationStarter, DeviceAuthorizer,
};
use crate::ports::PendingConsentPublisher;

/// Start an authorization-code flow — built by the `/oauth/authorize` handler.
pub(crate) type LiveCodeAuthorizationStarter = CodeAuthorizationStarter<SqliteGatekeeperStore>;

impl LiveCodeAuthorizationStarter {
    /// Lift the store, the popup publisher, the self-hosted redirect seam, and
    /// the first-party `client_id` out of the state.
    pub(crate) fn from_state(state: &Arc<GatekeeperState>) -> Self {
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

impl LiveDeviceAuthorizer {
    /// Lift the store and the popup publisher out of the state.
    pub(crate) fn from_state(state: &Arc<GatekeeperState>) -> Self {
        let publisher: Arc<dyn PendingConsentPublisher> = state.clone();
        DeviceAuthorizer::new(state.store.clone(), publisher)
    }
}

/// Poll an authorization request — built by the `/oauth/authorize/{id}`
/// handler.
pub(crate) type LiveAuthorizationStatusReader = AuthorizationStatusReader<SqliteGatekeeperStore>;

impl LiveAuthorizationStatusReader {
    /// Lift the store out of the state.
    pub(crate) fn from_state(state: &GatekeeperState) -> Self {
        AuthorizationStatusReader::new(state.store.clone())
    }
}
