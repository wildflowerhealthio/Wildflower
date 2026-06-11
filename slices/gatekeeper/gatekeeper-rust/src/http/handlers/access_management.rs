use axum::extract::{Extension, Path};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};

use crate::http::responses::{internal_error, not_found};
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
        Err(e) => internal_error("all_grants lookup failed", e),
    }
}

async fn get_grant(Extension(state): Extension<AppState>, Path(id): Path<String>) -> Response {
    match state.store.grant_by_id(&id) {
        Ok(Some(row)) => Json(row).into_response(),
        Ok(None) => not_found("GrantNotFound", "id", &id),
        Err(e) => internal_error("grant_by_id lookup failed", e),
    }
}

async fn revoke_grant(Extension(state): Extension<AppState>, Path(id): Path<String>) -> Response {
    match state.store.revoke_grant(&id) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => not_found("GrantNotFound", "id", &id),
        Err(e) => internal_error("revoke_grant failed", e),
    }
}
