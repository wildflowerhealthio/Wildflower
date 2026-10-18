//! The consent raiser's binding — where the store-generic [`ConsentRaiser`]
//! meets the concrete `SqliteGrantStore` and the
//! `Arc<AuthorizationServerState>` router state. Fixed-scope
//! ([`FixedScopeCapability`]): it takes what reading the prompt takes. See the
//! [module docs](super) for the binding seam.

use std::sync::Arc;

use wildflowerhealthio_scopes::Scope;

use super::state::AuthorizationServerState;
use crate::db::SqliteGrantStore;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::access::consents::consent_reader_scopes;
use crate::domain::capabilities::{ConsentRaiser, FixedScopeCapability};
use crate::domain::token::VerifiedClaims;
use crate::ports::OwnerApproval;

/// Raise pending code-flow consent prompts for the Owner.
pub(crate) type LiveConsentRaiser = ConsentRaiser<SqliteGrantStore>;

impl FixedScopeCapability for LiveConsentRaiser {
    type State = Arc<AuthorizationServerState>;
    type Claims = VerifiedClaims;
    type Error = AuthorizationServerError;

    fn required_scopes() -> Vec<Scope> {
        consent_reader_scopes()
    }

    fn build(state: Arc<AuthorizationServerState>) -> Self {
        // `Arc<AuthorizationServerState>` implements `OwnerApproval` (via the bare
        // state's impl), so it coerces to the port handle the capability holds.
        let owner_approval: Arc<dyn OwnerApproval> = state.clone();
        ConsentRaiser::new(state.store.clone(), owner_approval)
    }
}
