//! The pre-auth `/oauth` front-door bindings — the public and client-gated
//! capabilities over the concrete `SqliteGrantStore`. None is scope-gated
//! (a browser arriving at `/authorize` or `/sign-in` holds no token; a device
//! request is gated by its `AuthenticatedClient` proof, a sign-in by its
//! code), so none has a `Capability` impl; the handlers acquire them through
//! `Live<…>` via [`FromState`].

use std::sync::Arc;

use super::state::AuthorizationServerState;
use super::FromState;
use crate::db::SqliteGrantStore;
use crate::domain::capabilities::oauth::{
    AuthorizationStatusReader, CodeAuthorizationStarter, DeviceAuthorizer, PublicKeysReader,
    SameDeviceSignIn,
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
            state.wildflower_host_app_client_id.clone(),
            state.server_origin.clone(),
        )
    }
}

/// Sign a browser in as the Owner with a code the base minted — built by the
/// `/oauth/sign-in` handler.
pub(crate) type LiveSameDeviceSignIn = SameDeviceSignIn<SqliteGrantStore>;

impl FromState for LiveSameDeviceSignIn {
    fn from_state(state: &Arc<AuthorizationServerState>) -> Self {
        SameDeviceSignIn::new(
            state.store.clone(),
            state.same_device_sign_in_codes.clone(),
            state.sign_in_destinations.clone(),
            state.server_origin.clone(),
            state.owner_grant.clone(),
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
