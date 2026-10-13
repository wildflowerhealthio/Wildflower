//! The consent bindings — where the store-generic [`ConsentReader`] /
//! [`ConsentDecider`] capabilities meet the concrete `SqliteGrantStore` and
//! the `Arc<AuthorizationServerState>` router state. [`LiveConsentDecider`] is the
//! variable-scope flavour ([`Capability`], built with the caller's [`Grant`]);
//! [`LiveConsentReader`] is fixed-scope. See the [module docs](super) for the
//! binding seam.

use std::sync::Arc;

use wildflowerhealthio_scopes::Scope;

use super::state::AuthorizationServerState;
use crate::db::SqliteGrantStore;
use crate::domain::capabilities::access::consents::consent_reader_scopes;
use crate::domain::capabilities::{ConsentReader, FixedScopeCapability};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::token::VerifiedClaims;

/// Read pending consent prompts.
pub(crate) type LiveConsentReader = ConsentReader<SqliteGrantStore>;

impl FixedScopeCapability for LiveConsentReader {
    type State = Arc<AuthorizationServerState>;
    type Claims = VerifiedClaims;
    type Error = AuthorizationServerError;

    fn required_scopes() -> Vec<Scope> {
        consent_reader_scopes()
    }

    fn build(state: Arc<AuthorizationServerState>) -> Self {
        ConsentReader::new(state.store.clone())
    }
}
