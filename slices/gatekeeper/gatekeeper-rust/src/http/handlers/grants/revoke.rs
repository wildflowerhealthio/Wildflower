use axum::extract::{Extension, Path};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, MethodRouter};
use chrono::Utc;

use crate::http::response_templates;
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
) -> Response {
    // Load before deleting so the client_id is still known afterwards —
    // revoking consent must also kill the standing credentials minted under
    // it, or `offline_access` clients would outlive their revocation.
    let grant = match state.store.grant_by_id(&id) {
        Ok(Some(g)) => g,
        Ok(None) => return response_templates::not_found("GrantNotFound", "id", &id),
        Err(e) => return response_templates::internal_error("grant_by_id lookup failed", e),
    };
    match state.store.revoke_grant(&id) {
        Ok(true) => {}
        Ok(false) => return response_templates::not_found("GrantNotFound", "id", &id),
        Err(e) => return response_templates::internal_error("revoke_grant failed", e),
    }
    // Refresh-token families don't record a redirect_uri, so revocation is
    // keyed by client_id — deliberately broader than the single grant (a
    // revoked client re-earns credentials by re-running the auth flow). The
    // families are expired in place, not deleted, so the lineage stays
    // auditable.
    if let Err(e) = state
        .store
        .expire_refresh_token_families_for_client(&grant.client_id, Utc::now())
    {
        return response_templates::internal_error(
            "expire_refresh_token_families_for_client failed",
            e,
        );
    }
    StatusCode::NO_CONTENT.into_response()
}
