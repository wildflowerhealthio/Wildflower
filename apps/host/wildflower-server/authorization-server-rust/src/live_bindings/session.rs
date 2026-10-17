//! The session bindings — the [`TokenVerifier`] both authN gates run, the
//! [`BrowserSessionUseRecorder`] the host's cookie→bearer layer records a
//! browser session's cookie use through, and the
//! authenticated-only [`SessionEnder`] / [`SessionReader`] the `/authorization`
//! self-service handlers acquire through `Authenticated<…>`, over the concrete
//! runtime types. See the [module docs](super) for the binding seam.

use std::sync::Arc;

use wildflowerhealthio_scope_capabilities::AuthenticatedCapability;

use super::state::AuthorizationServerState;
use super::FromState;
use crate::db::SqliteGrantStore;
use crate::domain::capabilities::session::{
    BrowserSessionUseRecorder, SessionEnder, SessionReader, TokenVerifier,
};
use crate::domain::token::VerifiedClaims;

/// Verify presented access tokens — built by the two authN gates.
pub(crate) type LiveTokenVerifier = TokenVerifier<SqliteGrantStore>;

impl FromState for LiveTokenVerifier {
    fn from_state(state: &Arc<AuthorizationServerState>) -> Self {
        TokenVerifier::new(
            state.store.clone(),
            state.revocation_check(),
            state.server_origin.clone(),
        )
    }
}

/// Record a browser session's cookie use — built by
/// [`record_browser_session_cookie_use`](crate::record_browser_session_cookie_use),
/// which the host's cookie→bearer layer calls once it accepts the cookie.
pub(crate) type LiveBrowserSessionUseRecorder = BrowserSessionUseRecorder<SqliteGrantStore>;

impl FromState for LiveBrowserSessionUseRecorder {
    fn from_state(state: &Arc<AuthorizationServerState>) -> Self {
        BrowserSessionUseRecorder::new(state.store.clone(), state.last_seen_throttle.clone())
    }
}

/// End the caller's own session — `Authenticated<LiveSessionEnder>` in the
/// logout handler.
pub(crate) type LiveSessionEnder = SessionEnder;

impl AuthenticatedCapability for LiveSessionEnder {
    type State = Arc<AuthorizationServerState>;
    type Claims = VerifiedClaims;

    fn build(state: Arc<AuthorizationServerState>, claims: VerifiedClaims) -> Self {
        SessionEnder::new(state.revocation(), claims)
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
