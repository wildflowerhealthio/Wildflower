//! The `/authorization` bindings: each scope-gated capability over the
//! concrete `SqliteGrantStore`, built from the router state and the caller's
//! claims by its [`FixedScopeCapability`] (one required scope set) or
//! [`Capability`] (a grant the capability checks per call) impl. Handlers
//! acquire them through `Scoped<…>`, which checks the required scopes before
//! the capability exists.

use std::sync::Arc;

use wildflowerhealthio_scopes::{Grant, Scope};

use super::state::AuthorizationServerState;
use crate::db::SqliteGrantStore;
use crate::domain::access_token::VerifiedClaims;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::access::browser_sessions::{
    browser_sessions_reader_scopes, browser_sessions_revoker_scopes,
};
use crate::domain::capabilities::access::clients::{
    clients_disabler_scopes, clients_reader_scopes,
};
use crate::domain::capabilities::access::consents::{
    consent_decider_scopes, consent_reader_scopes,
};
use crate::domain::capabilities::access::grants::{grants_reader_scopes, grants_revoker_scopes};
use crate::domain::capabilities::access::tokens::token_revoker_scopes;
use crate::domain::capabilities::{
    BrowserSessionsReader, BrowserSessionsRevoker, Capability, ClientsDisabler, ClientsReader,
    ConsentDecider, ConsentRaiser, ConsentReader, FixedScopeCapability, GrantsReader,
    GrantsRevoker, TokenRevoker,
};
use crate::ports::OwnerApproval;

/// Read standing grants — `Scoped<LiveGrantsReader>` in the handler.
pub(crate) type LiveGrantsReader = GrantsReader<SqliteGrantStore>;

impl FixedScopeCapability for LiveGrantsReader {
    type State = Arc<AuthorizationServerState>;
    type Claims = VerifiedClaims;
    type Error = AuthorizationServerError;

    fn required_scopes() -> Vec<Scope> {
        grants_reader_scopes()
    }

    fn build(state: Arc<AuthorizationServerState>) -> Self {
        GrantsReader::new(state.store.clone())
    }
}

/// Revoke a standing grant (with the token-kill cascade).
pub(crate) type LiveGrantsRevoker = GrantsRevoker<SqliteGrantStore>;

impl FixedScopeCapability for LiveGrantsRevoker {
    type State = Arc<AuthorizationServerState>;
    type Claims = VerifiedClaims;
    type Error = AuthorizationServerError;

    fn required_scopes() -> Vec<Scope> {
        grants_revoker_scopes()
    }

    fn build(state: Arc<AuthorizationServerState>) -> Self {
        GrantsRevoker::new(state.store.clone(), state.revocation())
    }
}

/// List registered clients — `Scoped<LiveClientsReader>` in the handler.
pub(crate) type LiveClientsReader = ClientsReader<SqliteGrantStore>;

impl FixedScopeCapability for LiveClientsReader {
    type State = Arc<AuthorizationServerState>;
    type Claims = VerifiedClaims;
    type Error = AuthorizationServerError;

    fn required_scopes() -> Vec<Scope> {
        clients_reader_scopes()
    }

    fn build(state: Arc<AuthorizationServerState>) -> Self {
        ClientsReader::new(state.store.clone())
    }
}

/// Disable or re-enable a registered client (never disable an essential one).
pub(crate) type LiveClientsDisabler = ClientsDisabler<SqliteGrantStore>;

impl FixedScopeCapability for LiveClientsDisabler {
    type State = Arc<AuthorizationServerState>;
    type Claims = VerifiedClaims;
    type Error = AuthorizationServerError;

    fn required_scopes() -> Vec<Scope> {
        clients_disabler_scopes()
    }

    fn build(state: Arc<AuthorizationServerState>) -> Self {
        ClientsDisabler::new(state.store.clone())
    }
}

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
        ConsentReader::new(state.store.clone(), granted)
    }
}

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
        ConsentDecider::new(state.store.clone(), owner_approval, granted)
    }
}

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
        TokenRevoker::new(state.revocation())
    }
}

/// List the live browser sessions — `Scoped<LiveBrowserSessionsReader>` in the handler.
pub(crate) type LiveBrowserSessionsReader = BrowserSessionsReader<SqliteGrantStore>;

impl FixedScopeCapability for LiveBrowserSessionsReader {
    type State = Arc<AuthorizationServerState>;
    type Claims = VerifiedClaims;
    type Error = AuthorizationServerError;

    fn required_scopes() -> Vec<Scope> {
        browser_sessions_reader_scopes()
    }

    fn build(state: Arc<AuthorizationServerState>) -> Self {
        BrowserSessionsReader::new(state.store.clone(), state.ended_at_run_start.clone())
    }
}

/// Revoke a browser session — `Scoped<LiveBrowserSessionsRevoker>` in the handler.
pub(crate) type LiveBrowserSessionsRevoker = BrowserSessionsRevoker<SqliteGrantStore>;

impl FixedScopeCapability for LiveBrowserSessionsRevoker {
    type State = Arc<AuthorizationServerState>;
    type Claims = VerifiedClaims;
    type Error = AuthorizationServerError;

    fn required_scopes() -> Vec<Scope> {
        browser_sessions_revoker_scopes()
    }

    fn build(state: Arc<AuthorizationServerState>) -> Self {
        BrowserSessionsRevoker::new(state.store.clone())
    }
}
