//! The session bindings — the [`TokenVerifier`] both authN gates run, and the
//! authenticated-only [`SessionEnder`] / [`SessionReader`] the `/access`
//! self-service handlers acquire through `Authenticated<…>`, over the concrete
//! runtime types. See the [module docs](super) for the binding seam.

use std::sync::Arc;

use wildflowerhealthio_scope_capabilities::AuthenticatedCapability;

use super::state::AuthorizationServerState;
use super::FromState;
use crate::db::SqliteGrantStore;
use crate::domain::capabilities::session::{SessionEnder, SessionReader, TokenVerifier};
use crate::domain::token::VerifiedClaims;
use crate::ports::{Revocation, RevocationCheck};

/// Verify presented access tokens — built by the two authN gates.
pub(crate) type LiveTokenVerifier = TokenVerifier<SqliteGrantStore>;

impl FromState for LiveTokenVerifier {
    fn from_state(state: &Arc<AuthorizationServerState>) -> Self {
        let revocation: Arc<dyn RevocationCheck> = Arc::new(state.revocation_store.clone());
        TokenVerifier::new(state.store.clone(), revocation, state.server_origin.clone())
    }
}

/// End the caller's own session — `Authenticated<LiveSessionEnder>` in the
/// logout handler.
pub(crate) type LiveSessionEnder = SessionEnder;

impl AuthenticatedCapability for LiveSessionEnder {
    type State = Arc<AuthorizationServerState>;
    type Claims = VerifiedClaims;

    fn build(state: Arc<AuthorizationServerState>, claims: VerifiedClaims) -> Self {
        let revocation: Arc<dyn Revocation> = Arc::new(state.revocation_store.clone());
        SessionEnder::new(revocation, claims)
    }
}

/// Read the caller's own session — `Authenticated<LiveSessionReader>` in the
/// session handler.
pub(crate) type LiveSessionReader = SessionReader;

impl AuthenticatedCapability for LiveSessionReader {
    type State = Arc<AuthorizationServerState>;
    type Claims = VerifiedClaims;

    fn build(_state: Arc<AuthorizationServerState>, claims: VerifiedClaims) -> Self {
        SessionReader::new(claims)
    }
}
