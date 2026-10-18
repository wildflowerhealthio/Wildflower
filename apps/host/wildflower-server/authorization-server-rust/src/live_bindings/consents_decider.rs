//! The consent bindings — where the store-generic [`ConsentReader`] /
//! [`ConsentDecider`] capabilities meet the concrete `SqliteGrantStore` and
//! the `Arc<AuthorizationServerState>` router state. Both are the
//! variable-scope flavour ([`Capability`], built with the caller's [`Grant`]):
//! the decider checks a request's approval scopes against it, and the reader
//! says which of them its caller lacks. See the [module docs](super) for the
//! binding seam.

use std::sync::Arc;

use wildflowerhealthio_scopes::{Grant, Scope};

use super::state::AuthorizationServerState;
use crate::db::SqliteGrantStore;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::access::consents::consent_decider_scopes;
use crate::domain::capabilities::{Capability, ConsentDecider};
use crate::domain::token::VerifiedClaims;
use crate::ports::OwnerApproval;

/// Decide (approve/deny) pending consent prompts.
pub(crate) type LiveConsentDecider = ConsentDecider<SqliteGrantStore>;

impl Capability for LiveConsentDecider {
    type State = Arc<AuthorizationServerState>;
    type Claims = VerifiedClaims;
    type Error = AuthorizationServerError;

    fn required_scopes() -> Vec<Scope> {
        consent_decider_scopes()
    }

    fn build(state: Arc<AuthorizationServerState>, granted: Grant) -> Self {
        // `Arc<AuthorizationServerState>` implements `OwnerApproval` (via the bare
        // state's impl), so it coerces to the port handle the capability holds.
        let owner_approval: Arc<dyn OwnerApproval> = state.clone();
        ConsentDecider::new(
            state.store.clone(),
            owner_approval,
            granted,
            state.wildflower_host_app_client_id.clone(),
        )
    }
}
