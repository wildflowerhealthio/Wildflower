//! The session bindings: the [`TokenVerifier`] both authN gates run (and
//! the [`InProcessTokenVerifier`] the host's FHIR server verifies bearers
//! with), the [`BrowserSessionUseRecorder`] the host's cookie→bearer layer
//! records a browser session's cookie use through, the
//! [`BrowserSessionEnder`] `/oauth/sign-out` ends a browser's own session
//! with, and the authenticated-only [`SessionEnder`] / [`SessionReader`] the
//! `/authorization` self-service handlers acquire through
//! `Authenticated<…>`.

use std::sync::Arc;

use wildflowerhealthio_scope_capabilities::AuthenticatedCapability;

use super::state::AuthorizationServerState;
use super::FromState;
use crate::db::SqliteGrantStore;
use crate::domain::access_token::{AccessTokenVerifyError, VerifiedClaims};
use crate::domain::capabilities::session::{
    BrowserSessionEnder, BrowserSessionUseRecorder, SessionEnder, SessionReader, TokenVerifier,
};
use crate::ports::OwnerApproval;

/// Verify presented access tokens — built by the two authN gates.
pub(crate) type LiveTokenVerifier = TokenVerifier<SqliteGrantStore>;

impl FromState for LiveTokenVerifier {
    fn from_state(state: &Arc<AuthorizationServerState>) -> Self {
        TokenVerifier::new(
            state.store.clone(),
            state.revocation_check(),
            state.server_origin.clone(),
            state.stale_session_cutoff.clone(),
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
        let owner_approval: Arc<dyn OwnerApproval> = state.clone();
        BrowserSessionEnder::new(state.store.clone(), owner_approval)
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

/// Verify access tokens exactly as the authorization server's own gates do.
/// Cheap to clone. [`crate::setup_authorization_server`] hands one out on
/// [`AuthorizationServer::in_process_token_verifier`](crate::AuthorizationServer::in_process_token_verifier).
#[derive(Clone)]
pub struct InProcessTokenVerifier {
    /// The same verifier the server's own gates build from the state, shared
    /// between clones.
    verifier: Arc<LiveTokenVerifier>,
}

impl InProcessTokenVerifier {
    /// A verifier over the authorization server's state.
    pub(crate) fn new(state: &Arc<AuthorizationServerState>) -> Self {
        InProcessTokenVerifier {
            verifier: Arc::new(LiveTokenVerifier::from_state(state)),
        }
    }

    /// Verify `token`: signed with one of the stored keys, unexpired, its
    /// `iss` and `aud` both this server's origin, and not revoked.
    ///
    /// # Errors
    ///
    /// [`AccessTokenVerifyError::TokenRejected`] or [`AccessTokenVerifyError::Revoked`] for a token
    /// that doesn't pass; the other variants when the key, revocation or
    /// browser-session store can't be read
    /// ([`AccessTokenVerifyError::BrowserSessionStoreUnavailable`] for the last), which
    /// fails closed.
    pub fn verify(&self, token: &str) -> Result<VerifiedClaims, AccessTokenVerifyError> {
        self.verifier.verify(token)
    }
}
