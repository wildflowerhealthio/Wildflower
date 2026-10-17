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
use crate::domain::capabilities::access::consents::consent_reader_scopes;
use crate::domain::capabilities::{Capability, ConsentReader};
use crate::domain::token::VerifiedClaims;

/// Read pending consent prompts.
pub(crate) type LiveConsentReader = ConsentReader<SqliteGrantStore>;

impl Capability for LiveConsentReader {
    type State = Arc<AuthorizationServerState>;
    type Claims = VerifiedClaims;
    type Error = AuthorizationServerError;

    fn required_scopes() -> Vec<Scope> {
        consent_reader_scopes()
    }

    fn build(state: Arc<AuthorizationServerState>, granted: Grant) -> Self {
        ConsentReader::new(
            state.store.clone(),
            granted,
            state.wildflower_host_app_client_id.clone(),
        )
    }
}
