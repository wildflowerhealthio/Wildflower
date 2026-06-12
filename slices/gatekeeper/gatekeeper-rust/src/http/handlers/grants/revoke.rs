use axum::extract::{Extension, Path};
use axum::http::StatusCode;
use axum::routing::{delete, MethodRouter};
use chrono::Utc;

use crate::http::response_templates::HandlerError;
use crate::http::state::AppState;

/// `DELETE /grants/{id}` — revoke a grant and expire the refresh-token families
/// minted under its client, so `offline_access` clients can't outlive the
/// revocation.
pub(super) fn route() -> MethodRouter {
    delete(handle_revoke_grant)
}

async fn handle_revoke_grant(
    Extension(state): Extension<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, HandlerError> {
    // Load before deleting so the client_id is still known afterwards —
    // revoking consent must also kill the standing credentials minted under
    // it, or `offline_access` clients would outlive their revocation.
    let grant = state
        .store
        .grant_by_id(&id)
        .map_err(|e| HandlerError::internal("grant_by_id lookup failed", e))?
        .ok_or_else(|| HandlerError::not_found("GrantNotFound", "id", &id))?;
    let revoked = state
        .store
        .revoke_grant(&id)
        .map_err(|e| HandlerError::internal("revoke_grant failed", e))?;
    if !revoked {
        return Err(HandlerError::not_found("GrantNotFound", "id", &id));
    }
    // Refresh-token families don't record a redirect_uri, so revocation is
    // keyed by client_id — deliberately broader than the single grant (a
    // revoked client re-earns credentials by re-running the auth flow). The
    // families are expired in place, not deleted, so the lineage stays
    // auditable.
    state
        .store
        .expire_refresh_token_families_for_client(&grant.client_id, Utc::now())
        .map_err(|e| HandlerError::internal("expire_refresh_token_families_for_client failed", e))?;
    Ok(StatusCode::NO_CONTENT)
}
