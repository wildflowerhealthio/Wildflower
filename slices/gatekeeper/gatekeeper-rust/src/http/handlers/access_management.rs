use axum::extract::{Extension, Path};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::Utc;

use crate::http::response_templates;
use crate::http::state::AppState;

/// Owner-scoped `/grants` management API — list, fetch, and revoke previously
/// granted client consents.
pub fn router() -> Router {
    Router::new()
        .route("/grants", get(list_grants))
        .route("/grants/{id}", get(get_grant).delete(revoke_grant))
}

async fn list_grants(Extension(state): Extension<AppState>) -> Response {
    match state.store.all_grants() {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => response_templates::internal_error("all_grants lookup failed", e),
    }
}

async fn get_grant(Extension(state): Extension<AppState>, Path(id): Path<String>) -> Response {
    match state.store.grant_by_id(&id) {
        Ok(Some(row)) => Json(row).into_response(),
        Ok(None) => response_templates::not_found("GrantNotFound", "id", &id),
        Err(e) => response_templates::internal_error("grant_by_id lookup failed", e),
    }
}

async fn revoke_grant(Extension(state): Extension<AppState>, Path(id): Path<String>) -> Response {
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
