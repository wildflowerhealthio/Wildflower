//! The session bindings — the [`TokenVerifier`] both authN gates run, and the
//! authenticated-only [`SessionEnder`] / [`SessionReader`] the `/access`
//! self-service handlers acquire through `Authenticated<…>`, over the concrete
//! runtime types. See the [module docs](super) for the binding seam.

use std::sync::Arc;

use scope_capabilities_rust::AuthenticatedCapability;

use super::state::GatekeeperState;
use super::FromState;
use crate::db::SqliteGatekeeperStore;
use crate::domain::capabilities::session::{SessionEnder, SessionReader, TokenVerifier};
use crate::domain::token::VerifiedClaims;
use crate::ports::{Revocation, RevocationCheck};

/// Verify presented access tokens — built by the two authN gates.
pub(crate) type LiveTokenVerifier = TokenVerifier<SqliteGatekeeperStore>;

impl FromState for LiveTokenVerifier {
    fn from_state(state: &Arc<GatekeeperState>) -> Self {
        let revocation: Arc<dyn RevocationCheck> = Arc::new(state.revocation_store.clone());
        TokenVerifier::new(state.store.clone(), revocation)
    }
}

/// End the caller's own session — `Authenticated<LiveSessionEnder>` in the
/// logout handler.
pub(crate) type LiveSessionEnder = SessionEnder;

impl AuthenticatedCapability for LiveSessionEnder {
    type State = Arc<GatekeeperState>;
    type Claims = VerifiedClaims;

    fn build(state: Arc<GatekeeperState>, claims: VerifiedClaims) -> Self {
        let revocation: Arc<dyn Revocation> = Arc::new(state.revocation_store.clone());
        SessionEnder::new(revocation, claims)
    }
}

/// Read the caller's own session — `Authenticated<LiveSessionReader>` in the
/// session handler.
pub(crate) type LiveSessionReader = SessionReader;

impl AuthenticatedCapability for LiveSessionReader {
    type State = Arc<GatekeeperState>;
    type Claims = VerifiedClaims;

    fn build(_state: Arc<GatekeeperState>, claims: VerifiedClaims) -> Self {
        SessionReader::new(claims)
    }
}
