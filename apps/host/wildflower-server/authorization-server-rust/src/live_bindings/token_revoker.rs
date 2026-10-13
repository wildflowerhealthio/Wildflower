//! The token bindings — where the [`TokenRevoker`] capability meets the shared
//! [`RevocationStore`](wildflowerhealthio_token_revocation::RevocationStore) and the
//! `Arc<AuthorizationServerState>` router state. See the [module docs](super) for the
//! binding seam.

use std::sync::Arc;

use wildflowerhealthio_scopes::Scope;

use super::state::AuthorizationServerState;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::access::tokens::token_revoker_scopes;
use crate::domain::capabilities::{FixedScopeCapability, TokenRevoker};
use crate::domain::token::VerifiedClaims;

/// Revoke issued tokens.
pub(crate) type LiveTokenRevoker = TokenRevoker;

impl FixedScopeCapability for LiveTokenRevoker {
    type State = Arc<AuthorizationServerState>;
    type Claims = VerifiedClaims;
    type Error = AuthorizationServerError;

    fn required_scopes() -> Vec<Scope> {
        token_revoker_scopes()
    }

    fn build(state: Arc<AuthorizationServerState>) -> Self {
        TokenRevoker::new(Arc::new(state.revocation_store.clone()))
    }
}
