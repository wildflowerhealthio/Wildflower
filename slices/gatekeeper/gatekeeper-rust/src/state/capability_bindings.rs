//! The `Capability` bindings — where the generic, store-agnostic capabilities in
//! [`crate::domain::capabilities`] meet the concrete [`SqliteGatekeeperStore`] and
//! the `Arc<GatekeeperState>` router state. Each binding lifts the store + port
//! handles out of the state (it never hands the capability the whole state), so
//! `domain/` stays free of both `crate::http` and the concrete adapter types. The
//! `type …Cap` aliases are what the `/access` handlers name in `Scoped<…>`.

use std::sync::Arc;

use scopes_rust::{Grant, Scope};

use crate::db::SqliteGatekeeperStore;
use crate::domain::capabilities::{
    consents, grants, tokens, Capability, ConsentDecider, ConsentReader, FixedScopeCapability,
    GrantsReader, GrantsRevoker, TokenRevoker,
};
use crate::domain::token::VerifiedClaims;
use crate::ports::DeviceUserCodePublisher;
use crate::state::GatekeeperState;

/// Read standing grants — `Scoped<GrantsReaderCap>` in the handler.
pub(crate) type GrantsReaderCap = GrantsReader<SqliteGatekeeperStore>;
/// Revoke a standing grant (with the token-kill cascade).
pub(crate) type GrantsRevokerCap = GrantsRevoker<SqliteGatekeeperStore>;
/// Read pending consent prompts.
pub(crate) type ConsentReaderCap = ConsentReader<SqliteGatekeeperStore>;
/// Decide (approve/deny) pending consent prompts.
pub(crate) type ConsentDeciderCap = ConsentDecider<SqliteGatekeeperStore>;
/// Revoke issued tokens.
pub(crate) type TokenRevokerCap = TokenRevoker;

impl FixedScopeCapability for GrantsReaderCap {
    type State = Arc<GatekeeperState>;
    type Claims = VerifiedClaims;

    fn required_scopes() -> Vec<Scope> {
        grants::grants_reader_scopes()
    }

    fn build(state: Arc<GatekeeperState>) -> Self {
        GrantsReader::new(state.store.clone())
    }
}

impl FixedScopeCapability for GrantsRevokerCap {
    type State = Arc<GatekeeperState>;
    type Claims = VerifiedClaims;

    fn required_scopes() -> Vec<Scope> {
        grants::grants_revoker_scopes()
    }

    fn build(state: Arc<GatekeeperState>) -> Self {
        GrantsRevoker::new(
            state.store.clone(),
            Arc::new(state.revocation_store.clone()),
        )
    }
}

impl FixedScopeCapability for ConsentReaderCap {
    type State = Arc<GatekeeperState>;
    type Claims = VerifiedClaims;

    fn required_scopes() -> Vec<Scope> {
        consents::consent_reader_scopes()
    }

    fn build(state: Arc<GatekeeperState>) -> Self {
        ConsentReader::new(state.store.clone())
    }
}

impl Capability for ConsentDeciderCap {
    type State = Arc<GatekeeperState>;
    type Claims = VerifiedClaims;

    fn required_scopes() -> Vec<Scope> {
        consents::consent_decider_scopes()
    }

    fn build(state: Arc<GatekeeperState>, granted: Grant) -> Self {
        // `Arc<GatekeeperState>` implements `DeviceUserCodePublisher` (via the bare
        // state's impl), so it coerces to the port handle the capability holds.
        let publisher: Arc<dyn DeviceUserCodePublisher> = state.clone();
        ConsentDecider::new(state.store.clone(), publisher, granted)
    }
}

impl FixedScopeCapability for TokenRevokerCap {
    type State = Arc<GatekeeperState>;
    type Claims = VerifiedClaims;

    fn required_scopes() -> Vec<Scope> {
        tokens::token_revoker_scopes()
    }

    fn build(state: Arc<GatekeeperState>) -> Self {
        TokenRevoker::new(Arc::new(state.revocation_store.clone()))
    }
}
