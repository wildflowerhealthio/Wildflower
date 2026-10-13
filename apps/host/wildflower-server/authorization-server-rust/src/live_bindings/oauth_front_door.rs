//! The pre-auth `/oauth` front-door bindings — the public and client-gated
//! capabilities over the concrete `SqliteGrantStore`. None is scope-gated
//! (a browser arriving at `/authorize` holds no token; a device request is
//! gated by its `AuthenticatedClient` proof), so none has a `Capability` impl;
//! the handlers acquire them through `Live<…>` via [`FromState`].

use std::sync::Arc;

use super::state::AuthorizationServerState;
use super::FromState;
use crate::db::SqliteGrantStore;
use crate::domain::capabilities::oauth::{
    AuthorizationStatusReader, CodeAuthorizationStarter, DeviceAuthorizer, LoopbackOwnerApprover,
    PublicKeysReader,
};
use crate::ports::OwnerApproval;

/// Start an authorization-code flow — built by the `/oauth/authorize` handler.
pub(crate) type LiveCodeAuthorizationStarter = CodeAuthorizationStarter<SqliteGrantStore>;

impl FromState for LiveCodeAuthorizationStarter {
    fn from_state(state: &Arc<AuthorizationServerState>) -> Self {
        let owner_approval: Arc<dyn OwnerApproval> = state.clone();
        CodeAuthorizationStarter::new(
            state.store.clone(),
            owner_approval,
            state.first_party_client_id.clone(),
            state.server_origin.clone(),
        )
    }
}

/// Put a direct-loopback login to the host's dialog — built by the
/// `/oauth/authorize` handler, which drives it off the async runtime.
pub(crate) type LiveLoopbackOwnerApprover = LoopbackOwnerApprover<SqliteGrantStore>;

impl FromState for LiveLoopbackOwnerApprover {
    fn from_state(state: &Arc<AuthorizationServerState>) -> Self {
        let owner_approval: Arc<dyn OwnerApproval> = state.clone();
        LoopbackOwnerApprover::new(
            state.store.clone(),
            owner_approval,
            state.loopback_consent_prompt.clone(),
            state.host_owner_grant.clone(),
            state.first_party_client_id.clone(),
        )
    }
}

/// Start a device authorization — built by the `/oauth/device_authorization`
/// handler.
pub(crate) type LiveDeviceAuthorizer = DeviceAuthorizer<SqliteGrantStore>;

impl FromState for LiveDeviceAuthorizer {
    fn from_state(state: &Arc<AuthorizationServerState>) -> Self {
        let owner_approval: Arc<dyn OwnerApproval> = state.clone();
        DeviceAuthorizer::new(state.store.clone(), owner_approval)
    }
}

/// Poll an authorization request — built by the `/oauth/authorize/{id}`
/// handler.
pub(crate) type LiveAuthorizationStatusReader = AuthorizationStatusReader<SqliteGrantStore>;

impl FromState for LiveAuthorizationStatusReader {
    fn from_state(state: &Arc<AuthorizationServerState>) -> Self {
        AuthorizationStatusReader::new(state.store.clone())
    }
}

/// Serve the public signing keys — built by the `/.well-known/jwks.json`
/// handler.
pub(crate) type LivePublicKeysReader = PublicKeysReader<SqliteGrantStore>;

impl FromState for LivePublicKeysReader {
    fn from_state(state: &Arc<AuthorizationServerState>) -> Self {
        PublicKeysReader::new(state.store.clone())
    }
}
