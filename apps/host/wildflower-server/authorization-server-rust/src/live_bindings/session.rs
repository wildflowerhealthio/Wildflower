//! The session bindings — the [`TokenVerifier`] both authN gates run, the
//! [`BrowserSessionUseRecorder`] the host's cookie→bearer layer records a
//! browser session's cookie use through, the [`BrowserSessionEnder`]
//! `/oauth/sign-out` ends a browser's own session with, and the
//! authenticated-only [`SessionEnder`] / [`SessionReader`] the `/authorization`
//! self-service handlers acquire through `Authenticated<…>`, over the concrete
//! runtime types. See the [module docs](super) for the binding seam.

use std::sync::Arc;

use wildflowerhealthio_scope_capabilities::AuthenticatedCapability;

use super::state::AuthorizationServerState;
use super::FromState;
use crate::db::SqliteGrantStore;
use crate::domain::capabilities::session::{
    BrowserSessionEnder, BrowserSessionUseRecorder, SessionEnder, SessionReader, TokenVerifier,
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

/// End a browser's own browser session — built by the `/oauth/sign-out`
/// handler, over the claims of the browser's own cookie.
pub(crate) type LiveBrowserSessionEnder = BrowserSessionEnder<SqliteGrantStore>;

impl FromState for LiveBrowserSessionEnder {
    fn from_state(state: &Arc<AuthorizationServerState>) -> Self {
        BrowserSessionEnder::new(state.store.clone())
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
pub(crate) type LiveSessionReader = SessionReader<SqliteGrantStore>;

impl AuthenticatedCapability for LiveSessionReader {
    type State = Arc<AuthorizationServerState>;
    type Claims = VerifiedClaims;

    fn build(state: Arc<AuthorizationServerState>, claims: VerifiedClaims) -> Self {
        SessionReader::new(state.store.clone(), claims)
    }
}
