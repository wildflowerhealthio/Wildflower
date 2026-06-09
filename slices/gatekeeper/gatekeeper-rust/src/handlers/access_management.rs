use axum::extract::{Extension, Path};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;

use crate::require_auth::AppState;

#[derive(Debug, Serialize)]
struct NotFound {
    error: &'static str,
    id: String,
}

pub fn router() -> Router {
    Router::new()
        .route("/grants", get(list_grants))
        .route("/grants/{id}", get(get_grant).delete(revoke_grant))
}

async fn list_grants(Extension(state): Extension<AppState>) -> Response {
    match state.store.all_grants().await {
        Ok(rows) => Json(rows).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn get_grant(Extension(state): Extension<AppState>, Path(id): Path<String>) -> Response {
    match state.store.grant_by_id(&id).await {
        Ok(Some(row)) => Json(row).into_response(),
        Ok(None) => not_found(&id),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn revoke_grant(Extension(state): Extension<AppState>, Path(id): Path<String>) -> Response {
    match state.store.revoke_grant(&id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => not_found(&id),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

fn not_found(id: &str) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(NotFound {
            error: "GrantNotFound",
            id: id.to_string(),
        }),
    )
        .into_response()
}

