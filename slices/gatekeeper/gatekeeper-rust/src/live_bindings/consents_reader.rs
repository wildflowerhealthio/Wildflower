//! The consent bindings — where the store-generic [`ConsentReader`] /
//! [`ConsentDecider`] capabilities meet the concrete `SqliteGatekeeperStore` and
//! the `Arc<GatekeeperState>` router state. [`LiveConsentDecider`] is the
//! variable-scope flavour ([`Capability`], built with the caller's [`Grant`]);
//! [`LiveConsentReader`] is fixed-scope. See the [module docs](super) for the
//! binding seam.

use std::sync::Arc;

use scopes_rust::Scope;

use super::state::GatekeeperState;
use crate::db::SqliteGatekeeperStore;
use crate::domain::capabilities::consents::consent_reader_scopes;
use crate::domain::capabilities::{ConsentReader, FixedScopeCapability};
use crate::domain::token::VerifiedClaims;

/// Read pending consent prompts.
pub(crate) type LiveConsentReader = ConsentReader<SqliteGatekeeperStore>;

impl FixedScopeCapability for LiveConsentReader {
    type State = Arc<GatekeeperState>;
    type Claims = VerifiedClaims;

    fn required_scopes() -> Vec<Scope> {
        consent_reader_scopes()
    }

    fn build(state: Arc<GatekeeperState>) -> Self {
        ConsentReader::new(
            state.store.clone(),
            state.self_hosted_redirects.clone(),
            state.first_party_client_id.clone(),
        )
    }
}
