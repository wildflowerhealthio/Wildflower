//! The token bindings — where the [`TokenRevoker`] capability meets the shared
//! [`RevocationStore`](token_revocation_rust::RevocationStore) and the
//! `Arc<GatekeeperState>` router state. See the [module docs](super) for the
//! binding seam.

use std::sync::Arc;

use scopes_rust::Scope;

use super::state::GatekeeperState;
use crate::domain::capabilities::access::tokens::token_revoker_scopes;
use crate::domain::capabilities::{FixedScopeCapability, TokenRevoker};
use crate::domain::token::VerifiedClaims;

/// Revoke issued tokens.
pub(crate) type LiveTokenRevoker = TokenRevoker;

impl FixedScopeCapability for LiveTokenRevoker {
    type State = Arc<GatekeeperState>;
    type Claims = VerifiedClaims;

    fn required_scopes() -> Vec<Scope> {
        token_revoker_scopes()
    }

    fn build(state: Arc<GatekeeperState>) -> Self {
        TokenRevoker::new(Arc::new(state.revocation_store.clone()))
    }
}
