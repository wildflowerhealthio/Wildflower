use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, MethodRouter};
use chrono::Utc;

use crate::domain::actions;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::http::state::GatekeeperState;

/// `DELETE /grants/{id}` — revoke a grant, expire the refresh-token families
/// minted under its client, and bump the client's revocation epoch so any
/// still-live *access* tokens die too — no `offline_access` client (or a leaked
/// live bearer) outlives the revocation.
pub(super) fn route() -> MethodRouter<Arc<GatekeeperState>> {
    delete(handle_revoke_grant)
}

async fn handle_revoke_grant(
    State(state): State<Arc<GatekeeperState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, GatekeeperError> {
    // Load before deleting so the client_id is still known afterwards —
    // revoking consent must also kill the standing credentials minted under
    // it, or `offline_access` clients would outlive their revocation.
    let grant = actions::get_grant(&state.store, &id)?;
    // Bulk-revoke the client's *live access tokens* by bumping its revocation
    // epoch, done BEFORE the grant delete so the security-critical step lands
    // first: if the delete then fails the caller retries (idempotent) with the
    // tokens already dead, and an epoch bump for a client whose grant vanished
    // in a concurrent race only over-revokes (harmless — the client re-earns
    // access by re-authorizing). Expiring the refresh-token families (below)
    // stops *new* access tokens; this stops the *outstanding* ones — together
    // they close the whole window. `sub = client_id` today, so this is
    // per-client; per-device needs a device handle in the token (see #269).
    state
        .revocation_store
        .revoke_subject_as_of_now(grant.client_id())
        .map_err(|e| GatekeeperError::infrastructure("revoke_subject_as_of_now failed", e))?;
    // Delete the grant and expire the client's refresh-token families in one
    // transaction, so a partial failure can't leave the grant gone while
    // `offline_access` tokens stay live. Refresh-token families don't record a
    // redirect_uri, so revocation is keyed by client_id — deliberately broader
    // than the single grant (a revoked client re-earns credentials by
    // re-running the auth flow). Families are expired in place, not deleted, so
    // the lineage stays auditable.
    actions::revoke_grant(&state.store, &id, grant.client_id(), Utc::now())?;
    Ok(StatusCode::NO_CONTENT)
}
