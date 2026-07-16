//! Grant facades — the `wildflower/Grant.*` capabilities behind
//! `/access/grants[/{id}]`.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use scopes_rust::{Grant, Permission, Scope, WildflowerResource};

use crate::domain::actions;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::grant::Grant as GrantRecord;
use crate::http::scoped::GatedService;
use crate::http::state::GatekeeperState;

/// Read access to standing client grants — `GET /access/grants[/{id}]`.
pub(crate) struct GrantsReader {
    state: Arc<GatekeeperState>,
}

impl GatedService for GrantsReader {
    type State = Arc<GatekeeperState>;
    type Claims = crate::domain::token::VerifiedClaims;

    fn required_scopes() -> Vec<Scope> {
        vec![Scope::wildflower(
            WildflowerResource::Grant,
            Permission::READ,
        )]
    }

    fn build(state: Arc<GatekeeperState>, _granted: &Grant) -> Self {
        GrantsReader { state }
    }
}

impl GrantsReader {
    /// Every standing client grant, for the Owner UI's list.
    pub(crate) fn list(&self) -> Result<Vec<GrantRecord>, GatekeeperError> {
        actions::all_grants(&self.state.store)
    }

    /// A single grant by id, or [`GatekeeperError::GrantNotFound`] when absent.
    pub(crate) fn get(&self, id: &str) -> Result<GrantRecord, GatekeeperError> {
        actions::get_grant(&self.state.store, id)
    }
}

/// Revoke access to a standing grant — `DELETE /access/grants/{id}`. Distinct
/// from [`GrantsReader`] because deleting a grant is a `Grant.d` capability, and
/// it carries the security-critical token-kill cascade.
pub(crate) struct GrantsRevoker {
    state: Arc<GatekeeperState>,
}

impl GatedService for GrantsRevoker {
    type State = Arc<GatekeeperState>;
    type Claims = crate::domain::token::VerifiedClaims;

    fn required_scopes() -> Vec<Scope> {
        vec![Scope::wildflower(
            WildflowerResource::Grant,
            Permission::DELETE,
        )]
    }

    fn build(state: Arc<GatekeeperState>, _granted: &Grant) -> Self {
        GrantsRevoker { state }
    }
}

impl GrantsRevoker {
    /// Revoke the grant, bump the client's revocation epoch (killing its live
    /// access tokens), and expire its refresh-token families — the whole cascade,
    /// so no `offline_access` client outlives its revoked consent. The epoch bump
    /// lands before the delete so the security-critical step is first and the
    /// operation is idempotent on retry (see the original `/grants/{id}` handler).
    pub(crate) fn revoke(&self, id: &str, now: DateTime<Utc>) -> Result<(), GatekeeperError> {
        let grant = actions::get_grant(&self.state.store, id)?;
        self.state
            .revocation_store
            .revoke_subject_as_of_now(grant.client_id())
            .map_err(|e| GatekeeperError::infrastructure("revoke_subject_as_of_now failed", e))?;
        actions::revoke_grant(&self.state.store, id, grant.client_id(), now)
    }
}
