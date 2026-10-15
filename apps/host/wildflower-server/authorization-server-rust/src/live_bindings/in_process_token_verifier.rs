//! The [`InProcessTokenVerifier`] binding — the [`TokenVerifier`] both authN
//! gates run, for in-process verifiers outside the authorization server: the
//! host's FHIR server verifies each bearer through it rather than fetching
//! `/.well-known/jwks.json` and re-implementing the policy.
//!
//! [`TokenVerifier`]: crate::domain::capabilities::session::TokenVerifier

use std::sync::Arc;

use super::session::LiveTokenVerifier;
use super::state::AuthorizationServerState;
use super::FromState;
use crate::domain::token::{VerifiedClaims, VerifyError};

/// Verify access tokens exactly as the authorization server's own gates do.
/// Cheap to clone. [`crate::setup_authorization_server`] hands one out on
/// [`AuthorizationServer::in_process_token_verifier`](crate::AuthorizationServer::in_process_token_verifier).
#[derive(Clone)]
pub struct InProcessTokenVerifier {
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
    /// [`VerifyError::TokenRejected`] or [`VerifyError::Revoked`] for a token
    /// that doesn't pass; the other variants when a key or revocation store
    /// can't be read, which fails closed.
    pub fn verify(&self, token: &str) -> Result<VerifiedClaims, VerifyError> {
        self.verifier.verify(token)
    }
}
